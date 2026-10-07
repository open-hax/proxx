// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Crypto/HTTP lifetime only. Authority and scope decisions are pure CLJC law.
const crypto = require('node:crypto');
const config = require('./kimi-publication-config.cjs');
const { publisherPrincipal } = require('./opencode-app-auth.cjs');
/**
 * Create a phase-only owned-App failure without exposing credentials or remote error content.
 */
function failure(phase) { const e = Error(`Owned Kimi App ${phase} failed`); e.phase = phase; return e; }
/**
 * Accept only a bounded printable credential string for private token handling and cleanup.
 */
const usable = x => typeof x === 'string' && x.length > 0 && x.length <= 16384 && !/[^\x21-\x7e]/.test(x);
/**
 * Sign a short-lived RS256 App JWT with the selected issuer and clock; callers retain authority and secret-lifetime checks.
 */
function signJWT(appID, key, now) {
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appID })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
/**
 * Authorize and scope a dedicated Proxx token before publication, then await revocation of any usable minted token on every exit.
 */
async function withOwnedKimiToken({ core, law, preMint, readKey, fetchImpl = fetch,
  sign = signJWT, now = () => Math.floor(Date.now() / 1000) }, use) {
  let token, result, error, phase = 'authority';
  try {
    law.authority(config);
    // Both the registry and law must agree on a physically separate static actor.
    const principal = publisherPrincipal('proxx-owned-kimi');
    if (!require('node:util').isDeepStrictEqual(principal, config.authority.principal)) throw Error('Identity mismatch');
    if (typeof preMint !== 'function' || typeof readKey !== 'function' || typeof use !== 'function') throw Error('Missing lifetime callback');
    phase = 'admission'; await preMint();
    phase = 'signing';
    const jwt = sign(config.authority.appID, readKey(), now());
    if (!usable(jwt)) throw Error('Invalid JWT'); core.setSecret(jwt);
    phase = 'mint';
    const response = await fetchImpl(`https://api.github.com/app/installations/${config.authority.installationID}/access_tokens`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ repository_ids: [1178288746], permissions: { metadata: 'read', pull_requests: 'write' } }),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    // Even an invalid/refused response with a usable minted token needs cleanup.
    const value = await response.json();
    if (usable(value?.token)) { token = value.token; core.setSecret(token); }
    if (!response.ok || !token) throw Error('Mint refused');
    phase = 'scope'; law.token({ value, now: now(), 'expires-seconds': Date.parse(value.expires_at) / 1000 });
    phase = 'publication'; result = await use(token);
  } catch { error = failure(phase); }
  finally {
    if (token) {
      try {
        const response = await fetchImpl('https://api.github.com/installation/token', { method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          redirect: 'error', signal: AbortSignal.timeout(20000) });
        if (response.status !== 204) throw Error('Revoke refused');
      } catch { const revoked = failure('revocation'); error = error ? new AggregateError([error, revoked], 'Owned Kimi App operation and revocation failed') : revoked; }
    }
  }
  if (error) throw error;
  return result;
}
module.exports = { withOwnedKimiToken, signJWT };
