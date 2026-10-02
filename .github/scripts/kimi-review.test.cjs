// SPDX-License-Identifier: GPL-3.0-or-later
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertHead, parseEvents, validateReview, discordPayloads } = require('./kimi-review.cjs');
const a = 'a'.repeat(40), b = 'b'.repeat(40);
test('stale execution and moving publication heads fail closed', () => {
  assertHead(a, a, a);
  assert.throws(() => assertHead(a, b, a));
  assert.throws(() => assertHead(a, a, b));
  assert.throws(() => assertHead('main', 'main'));
});
test('only model text forms the review, error and empty streams fail', () => {
  const text = JSON.stringify({ summary: 'No findings', comments: [] });
  assert.deepEqual(parseEvents(JSON.stringify({ type: 'text', part: { text } })), { summary: 'No findings', comments: [] });
  assert.throws(() => parseEvents(''));
  assert.throws(() => parseEvents(JSON.stringify({ type: 'error' })));
});
test('unsafe inline locations and missing or oversized review content fail', () => {
  assert.throws(() => validateReview({ summary: 'ok', comments: [{ path: '../secret', line: 1, body: 'bad' }] }));
  assert.throws(() => validateReview({ summary: 'ok', comments: [{ path: 'a', line: 0, body: 'bad' }] }));
  assert.throws(() => validateReview({ summary: 'ok', comments: [{ path: 'a', line: 1, body: 'x'.repeat(4001) }] }));
  assert.throws(() => validateReview({ summary: '', comments: [] }));
});
test('multiple long findings stay below Discord aggregate limits independently', () => {
  const comments = Array.from({ length: 12 }, () => ({ body: 'x'.repeat(8000), path: 'p'.repeat(3000), line: 123, user: { login: 'u'.repeat(400) } }));
  const payloads = discordPayloads(comments, 'repo'.repeat(100));
  assert.equal(payloads.length, 12);
  for (const payload of payloads) {
    const embed = payload.embeds[0];
    const length = embed.title.length + embed.description.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(length <= 6000);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  }
});
test('publication rejects a stale PR without creating a review', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { publish } = require('./kimi-review.cjs');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-test-'));
  const file = path.join(dir, 'review.json');
  fs.writeFileSync(file, JSON.stringify({ head, summary: 'ok', comments: [] }));
  let calls = 0;
  const github = { rest: { pulls: { get: async () => ({ data: { head: { sha: b } } }), createReview: async () => { calls++; } } } };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, head: { sha: head, repo: { full_name: 'o/r' } } } } };
  try { await assert.rejects(publish({ github, context, file })); assert.equal(calls, 0); }
  finally { fs.rmSync(dir, { recursive: true }); }
});
test('publisher binds commit and retrieves only its own submission comments', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { publish } = require('./kimi-review.cjs');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-test-'));
  const file = path.join(dir, 'review.json');
  fs.writeFileSync(file, JSON.stringify({ head, summary: 'ok', comments: [] }));
  const list = () => {};
  const listFiles = () => {};
  const github = { rest: { pulls: {
    get: async () => ({ data: { head: { sha: head } } }),
    createReview: async args => { assert.equal(args.commit_id, head); return { data: { id: 42 } }; },
    listCommentsForReview: list, listFiles,
  } }, paginate: async (method, args) => { if (method === listFiles) return []; assert.equal(method, list); assert.equal(args.review_id, 42); return [{ body: 'Own finding', path: 'a', line: 1 }]; } };
  let sent = 0;
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, head: { sha: head, repo: { full_name: 'o/r' } } } } };
  try {
    await publish({ github, context, file, webhookUrl: 'unused', fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).embeds[0].description, 'Own finding'); sent++; return { ok: true };
    } });
    assert.equal(sent, 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('intermediate assistant narration is excluded from the final structured reply', () => {
  const events = [
    { type: 'text', part: { messageID: 'inspection', text: 'I will inspect the changed source.' } },
    { type: 'tool_use', part: { messageID: 'inspection' } },
    { type: 'text', part: { messageID: 'final', text: '{"summary":"No findings",' } },
    { type: 'text', part: { messageID: 'final', text: '"comments":[]}' } },
  ];
  assert.deepEqual(parseEvents(events.map(JSON.stringify).join('\n')), { summary: 'No findings', comments: [] });
});

test('phantom locations are preserved as unattached findings instead of invalid inline submissions', () => {
  const { splitFindings } = require('./kimi-review.cjs');
  const valid = { path: 'a', line: 10, body: 'real' };
  const phantom = { path: 'a', line: 11, body: 'outside diff' };
  const absent = { path: 'binary', line: 1, body: 'no patch' };
  assert.deepEqual(splitFindings([valid, phantom, absent], [{ filename: 'a', patch: '@@ -9,1 +9,2 @@\n context\n+addition' }, { filename: 'binary' }]), {
    attached: [valid], unattached: [phantom, absent],
  });
});
