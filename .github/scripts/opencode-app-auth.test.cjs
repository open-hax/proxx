// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { withOpenCodeAppToken, publisherPrincipal, matchesPublisher } = require('./opencode-app-auth.cjs');

// Actual local HTTP requests, mapped only from the two audited URLs. All
// credentials below are synthetic fixture strings; no live authentication.
async function transportFixture(t, options = {}) {
  const calls = [], masks = []; let publications = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
      if (req.url === '/exchange_github_app_token') {
        res.writeHead(options.exchangeStatus || 200, { 'content-type': 'application/json' });
        res.end(options.response ?? JSON.stringify({ token: 'fixture-install-token' }));
      } else {
        res.writeHead(options.revokeStatus || 204); res.end(options.revokeStatus ? 'fixture-install-token' : undefined);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const core = { getIDToken: async audience => { assert.equal(audience, 'opencode-github-action'); return 'fixture-oidc-token'; }, setSecret: value => masks.push(value) };
  const fetchImpl = (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    const target = new URL(url);
    assert.equal(target.origin, target.pathname === '/exchange_github_app_token' ? 'https://api.opencode.ai' : 'https://api.github.com');
    assert.ok(['/exchange_github_app_token', '/installation/token'].includes(target.pathname));
    return fetch(origin + target.pathname, init);
  };
  const use = async token => { publications++; assert.equal(token, 'fixture-install-token'); assert.deepEqual(masks, ['fixture-oidc-token', token]);
    if (options.publicationFails) throw Error('fixture-install-token fixture-oidc-token');
    return { published: true }; };
  return { core, fetchImpl, use, calls, masks, publications: () => publications };
}
test('standalone exchange uses audited no-body API and revokes after trusted callback', async t => {
  const f = await transportFixture(t);
  assert.deepEqual(await withOpenCodeAppToken(f, f.use), { published: true });
  assert.deepEqual(f.calls.map(c => [c.method, c.url, c.body]), [['POST', '/exchange_github_app_token', ''], ['DELETE', '/installation/token', '']]);
  assert.equal(f.calls[0].authorization, 'Bearer fixture-oidc-token');
  assert.equal(f.calls[1].authorization, 'Bearer fixture-install-token');
  assert.equal(f.publications(), 1);
});
test('publication rejection is sanitized and still revokes the installation token', async t => {
  const f = await transportFixture(t, { publicationFails: true });
  await assert.rejects(withOpenCodeAppToken(f, f.use), e => e.phase === 'publication' && !JSON.stringify(e).includes('fixture-') && !e.stack.includes('fixture-'));
  assert.equal(f.calls.at(-1).method, 'DELETE');
});
for (const response of ['not-json', '{}', '[]', 'null', '{"token":false}', '{"token":""}', '{"token":"has space"}', '{"token":"bad\\r\\nheader"}']) {
  test(`invalid exchange envelope ${response} refuses publication without logging its body`, async t => {
    const f = await transportFixture(t, { response });
    await assert.rejects(withOpenCodeAppToken(f, f.use), e => e.phase === 'exchange' && !e.stack.includes('fixture-'));
    assert.equal(f.publications(), 0); assert.equal(f.calls.length, 1);
  });
}
test('strict extra-field refusal still masks and revokes a known minted token', async t => {
  const f = await transportFixture(t, { response: '{"token":"fixture-install-token","expires_at":"untrusted"}' });
  await assert.rejects(withOpenCodeAppToken(f, f.use), /exchange failed/);
  assert.equal(f.publications(), 0); assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.deepEqual(f.masks, ['fixture-oidc-token', 'fixture-install-token']);
});
test('HTTP failure body is never surfaced or treated as a token', async t => {
  const f = await transportFixture(t, { exchangeStatus: 403, response: '{"token":"fixture-install-token"}' });
  await assert.rejects(withOpenCodeAppToken(f, f.use), e => e.phase === 'exchange' && !e.stack.includes('fixture-'));
  assert.equal(f.publications(), 0); assert.equal(f.calls.length, 1);
});
for (const publicationFails of [false, true]) test(`revocation failure stays visible with publication failure=${publicationFails}`, async t => {
  const f = await transportFixture(t, { revokeStatus: 503, publicationFails });
  await assert.rejects(withOpenCodeAppToken(f, f.use), e => {
    const failures = e instanceof AggregateError ? e.errors : [e];
    assert.ok(failures.some(error => error.phase === 'revocation'));
    assert.equal(failures.some(error => error.phase === 'publication'), publicationFails);
    assert.ok(failures.every(error => !error.stack.includes('fixture-') && error.cause === undefined));
    return true;
  });
});
test('OIDC acquisition and transport exceptions expose only sanitized phases', async () => {
  for (const phase of ['oidc', 'exchange']) {
    let sends = 0;
    await assert.rejects(withOpenCodeAppToken({
      core: { getIDToken: async () => { if (phase === 'oidc') throw Error('fixture-oidc-token'); return 'fixture-oidc-token'; }, setSecret: () => {} },
      fetchImpl: async () => { sends++; throw Error('fixture-oidc-token'); },
    }, async () => assert.fail('No publication')), e => e.phase === phase && !e.stack.includes('fixture-') && !e.cause);
    assert.equal(sends, phase === 'oidc' ? 0 : 1);
  }
});
test('masking failure after minting refuses publication and still attempts revocation', async t => {
  const f = await transportFixture(t), mask = f.core.setSecret;
  f.core.setSecret = value => { mask(value); if (value === 'fixture-install-token') throw Error(value); };
  await assert.rejects(withOpenCodeAppToken(f, f.use), e => e.phase === 'exchange' && !e.stack.includes('fixture-'));
  assert.equal(f.publications(), 0); assert.equal(f.calls.at(-1).method, 'DELETE');
});
test('revocation transport rejection is visible and does not retry or return success', async t => {
  const f = await transportFixture(t), transport = f.fetchImpl; let revokes = 0;
  f.fetchImpl = async (url, init) => {
    if (init.method === 'DELETE') { revokes++; throw Error('fixture-install-token'); }
    return transport(url, init);
  };
  await assert.rejects(withOpenCodeAppToken(f, f.use), e => e.phase === 'revocation' && !e.stack.includes('fixture-'));
  assert.equal(f.publications(), 1); assert.equal(revokes, 1);
});
test('only immutable supported principal tuples are accepted; Bot name alone is insufficient', () => {
  for (const publisher of ['github-actions', 'opencode-agent']) {
    const principal = publisherPrincipal(publisher); assert.ok(Object.isFrozen(principal));
    assert.equal(matchesPublisher({ ...principal }, principal), true);
    for (const change of [u => u.id++, u => u.id = String(u.id), u => u.type = 'User', u => u.login += '-other']) {
      const user = { ...principal }; change(user); assert.equal(matchesPublisher(user, principal), false);
    }
  }
  for (const owner of ['eta-mu-ai', 'Bot', { login: 'opencode-agent[bot]' }, null]) assert.throws(() => publisherPrincipal(owner), /publisher/);
});
