// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { schema, publicationIntent } = require('./bridge.cjs');
const { structuredRequest } = require('../kimi-review.cjs');
const expected = { repository: 'open-hax/proxx', prNumber: 445,
  base: 'b'.repeat(40), head: 'a'.repeat(40), diffSha256: 'c'.repeat(64),
  coveredFiles: ['src/one.cljs'] };
const response = { ...expected, version: 2, verdict: 'approve', coverage: 'complete',
  summary: 'Completed review.', comments: [] };

test('actual owner schema crosses the JavaScript/Clojure boundary', async () => {
  const value = await schema(expected);
  assert.equal(value.additionalProperties, false);
  assert.equal(value.properties.version.const, 2);
  assert.deepEqual(value.properties.head, { const: expected.head });
  assert.deepEqual(value.properties.coveredFiles, { const: expected.coveredFiles });
});
test('explicit decisions yield proposals only, with no prose inference', async () => {
  assert.deepEqual(await publicationIntent(expected, response), { authority: 'proposal-only', event: 'APPROVE' });
  assert.deepEqual(await publicationIntent(expected, { ...response, coverage: 'incomplete' }),
    { authority: 'proposal-only', event: 'COMMENT' });
  assert.deepEqual(await publicationIntent(expected, { ...response, verdict: 'comment', summary: 'Approved. LGTM.' }),
    { authority: 'proposal-only', event: 'COMMENT' });
  assert.deepEqual(await publicationIntent(expected, { ...response, verdict: 'changes_requested',
    comments: [{ path: 'src/one.cljs', line: 1, body: 'A defect.' }] }),
    { authority: 'proposal-only', event: 'REQUEST_CHANGES' });
});
test('native JS mutation, contradictory decisions and malformed values refuse', async () => {
  for (const bad of [null, {}, { ...response, head: 'd'.repeat(40) },
    { ...response, approved: true }, { ...response, verdict: 'changes_requested' },
    { ...response, comments: [{ path: 'src/one.cljs', line: 1, body: 'Defect.' }] }]) {
    await assert.rejects(publicationIntent(expected, bad), /typed-kimi:/);
  }
  await assert.rejects(schema({ ...expected, coveredFiles: ['../escape'] }), /typed-kimi:invalid-context/);
});
test('legacy v1 structured request stays closed and unchanged', () => {
  const old = structuredRequest('Review', expected.head, expected).format.schema;
  assert.equal(old.additionalProperties, false);
  assert.deepEqual(old.required, ['head', 'diffSha256', 'coveredFiles', 'summary', 'comments']);
  assert.equal(old.properties.version, undefined);
  assert.equal(old.properties.verdict, undefined);
});
