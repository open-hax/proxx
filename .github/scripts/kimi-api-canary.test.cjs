'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { probe } = require('./kimi-api-canary.cjs');
function fixture() {
  const head = 'a'.repeat(40);
  const pr = { number: 450, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'o/r' } } };
  const context = { eventName: 'pull_request', repo: { owner: 'o', repo: 'r' }, payload: { repository: { full_name: 'o/r' }, pull_request: structuredClone(pr) } };
  let review, creates = 0, updates = 0; const receipts = [];
  const pulls = {
    get: async () => ({ data: pr }), listReviews: () => {},
    createReview: async args => { creates++; assert.equal(args.event, 'COMMENT'); review = { id: 42, body: args.body, commit_id: args.commit_id, state: 'COMMENTED', user: { login: 'github-actions[bot]' } }; return { data: { ...review } }; },
    updateReview: async args => { updates++; review.body = args.body; },
    getReview: async () => ({ data: { ...review } }),
  };
  return { context, pr, pulls, receipts, github: { rest: { pulls }, paginate: async () => review ? [{ ...review }] : [] },
    write: receipt => receipts.push(structuredClone(receipt)), counts: () => ({ creates, updates }) };
}
test('same-bot create/update/readback and exact-head rerun deduplication', async () => {
  const f = fixture(); const first = await probe(f); assert.equal(first.passed, true);
  assert.equal(f.receipts[0].passed, false); assert.equal(f.receipts[1].exactUtf8Readback, true);
  const second = await probe(f); assert.equal(second.reused, true); assert.deepEqual(f.counts(), { creates: 1, updates: 1 });
  assert.ok(!second.body.includes('kimi-discord-delivered'));
});
test('ineligible event/repository/head/live state fail before native mutation', async () => {
  for (const change of [f => f.context.eventName = 'push', f => f.context.payload.pull_request.draft = true,
    f => f.context.payload.pull_request.head.repo.full_name = 'fork/r', f => f.context.payload.pull_request.head.sha = 'main',
    f => f.pr.head.sha = 'b'.repeat(40), f => f.pr.draft = true, f => f.pr.state = 'closed', f => f.pr.head.repo.full_name = 'fork/r']) {
    const f = fixture(); change(f); await assert.rejects(probe(f)); assert.deepEqual(f.counts(), { creates: 0, updates: 0 });
  }
});
test('wrong native identity/commit/state fail and preserve partial create artifact', async () => {
  for (const change of [r => r.user.login = 'riatzukiza', r => r.commit_id = 'b'.repeat(40), r => r.state = 'APPROVED', r => r.body += 'edited']) {
    const f = fixture(), create = f.pulls.createReview;
    f.pulls.createReview = async args => { const result = await create(args); change(result.data); return result; };
    await assert.rejects(probe(f), /mismatch/); assert.equal(f.receipts[0].passed, false); assert.equal(f.counts().updates, 0);
  }
});
test('failed update and altered readback remain failed diagnostic artifacts', async () => {
  for (const stage of ['update', 'readback']) {
    const f = fixture();
    if (stage === 'update') f.pulls.updateReview = async () => { throw Error('update failed'); };
    else { const read = f.pulls.getReview; f.pulls.getReview = async args => { const r = await read(args); r.data.body += '\nchanged'; return r; }; }
    await assert.rejects(probe(f)); assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].passed, false);
  }
});
