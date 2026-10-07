// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Publication actors only. These tuples neither enroll a reviewer nor establish
// model identity, full coverage, a completed round or approval.
const PRINCIPALS = Object.freeze({
  'github-actions': Object.freeze({ login: 'github-actions[bot]', id: 41898282, type: 'Bot' }),
  'opencode-agent': Object.freeze({ login: 'opencode-agent[bot]', id: 219766164, type: 'Bot' }),
});
/**
 * Resolve an explicit publication actor; the dedicated Kimi actor requires a configured authority and supplies no reviewer enrollment.
 */
function publisherPrincipal(publisher = 'github-actions') {
  if (publisher === 'proxx-owned-kimi') {
    const authority = require('./kimi-publication-authority.cjs');
    if (authority.state !== 'configured' || !authority.principal) throw Error('Owned Kimi authority is unconfigured');
    return authority.principal;
  }
  if (typeof publisher !== 'string' || !Object.hasOwn(PRINCIPALS, publisher)) throw Error('Unsupported trusted publisher');
  return PRINCIPALS[publisher];
}
function matchesPublisher(user, principal) {
  return user?.login === principal.login && user?.id === principal.id && user?.type === principal.type;
}
function assertNativeReview(review, principal, head, id, body) {
  if (!matchesPublisher(review?.user, principal) || !Number.isSafeInteger(review?.id) || review.id <= 0 ||
      (id !== undefined && review.id !== id) || review.commit_id !== head || review.state !== 'COMMENTED' ||
      typeof review.body !== 'string' || (body !== undefined && !Buffer.from(review.body).equals(Buffer.from(body)))) {
    throw Error('Native review owner/identity/state/head/body mismatch');
  }
}
function assertNativeComment(comment, principal, head, reviewID) {
  if (!matchesPublisher(comment?.user, principal) || !Number.isSafeInteger(comment?.id) || comment.id <= 0 ||
      comment.pull_request_review_id !== reviewID || comment.commit_id !== head) {
    throw Error('Native submission comment owner/identity/head mismatch');
  }
}

function failure(phase) {
  const error = Error(`OpenCode App ${phase} failed`); error.phase = phase; return error;
}
function usableToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[^\x21-\x7e]/.test(value);
}
async function revokeInstallationToken(appToken, fetchImpl) {
  const response = await fetchImpl('https://api.github.com/installation/token', {
    method: 'DELETE', headers: { Authorization: `Bearer ${appToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (response.status !== 204) throw Error('Revocation refused');
}

// Protocol provenance: anomalyco/opencode v1.18.34, immutable
// aec0b9a6d8898f68f923aaf08b7306d931fd9d76 github.handler.ts and function/api.ts.
// Caller MUST run this in a fresh trusted publication job after inference, with
// id-token:write and no model credentials/server/candidate executable code.
// The inference job must lack OIDC permission. This helper cannot attest that
// workflow boundary, App identity or installation permission scope itself.
async function withOpenCodeAppToken({ core, fetchImpl = fetch }, use) {
  let appToken, result, error, phase = 'oidc';
  try {
    const oidc = await core.getIDToken('opencode-github-action');
    if (!usableToken(oidc)) throw Error('Invalid token');
    core.setSecret(oidc);
    phase = 'exchange';
    const response = await fetchImpl('https://api.opencode.ai/exchange_github_app_token', {
      method: 'POST', headers: { Authorization: `Bearer ${oidc}` },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error('Exchange refused');
    const value = await response.json();
    // Cleanup also covers a known minted token in an invalid envelope. Never
    // log the response body or pass its metadata to publication.
    if (usableToken(value?.token)) { appToken = value.token; core.setSecret(appToken); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
        !Object.hasOwn(value, 'token') || !appToken) throw Error('Invalid envelope');
    phase = 'publication';
    result = await use(appToken);
  } catch { error = failure(phase); }
  finally {
    if (appToken) {
      try {
        await revokeInstallationToken(appToken, fetchImpl);
      } catch { const revoked = failure('revocation'); error = error ? new AggregateError([error, revoked], 'OpenCode App operation and revocation failed') : revoked; }
    }
  }
  if (error) throw error;
  return result;
}
module.exports = { publisherPrincipal, matchesPublisher, assertNativeReview, assertNativeComment, withOpenCodeAppToken };
