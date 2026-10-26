// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { structuredRequest, parseSubmission } = require('./bridge.cjs');
const { structuredRequest: legacyRequest } = require('../kimi-review.cjs');
const expected = { repository: 'open-hax/proxx', prNumber: 445, base: 'b'.repeat(40),
  head: 'a'.repeat(40), diffSha256: 'c'.repeat(64), coveredFiles: ['src/a.cljs'] };
const binding = { sessionID: 'ses_test123', assistantID: 'msg_test123' };
const decision = { ...expected, version: 2, verdict: 'approve', coverage: 'complete',
  summary: 'Reviewed.', comments: [] };
function native(value = decision) {
  return { info: { role: 'assistant', id: binding.assistantID, sessionID: binding.sessionID,
    providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', variant: 'low',
    time: { completed: 123 }, structured: structuredClone(value) },
  parts: [{ type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: structuredClone(value) } }] };
}
test('v2 request uses owner schema with the existing explicit low route', async () => {
  const request = await structuredRequest(expected, 'Review the full immutable input.');
  const legacy = legacyRequest('Review', expected.head, expected);
  assert.deepEqual(request.model, legacy.model);
  assert.equal(request.variant, legacy.variant);
  assert.equal(request.agent, legacy.agent);
  assert.equal(request.format.schema.properties.version.const, 2);
  assert.equal(request.format.schema.additionalProperties, false);
  assert.deepEqual(request.format.schema.properties.repository, { const: expected.repository });
  assert.equal(request.parts[0].text, 'Review the full immutable input.');
  await assert.rejects(structuredRequest(expected, ''), /typed-kimi:invalid-prompt/);
  await assert.rejects(structuredRequest({ ...expected, head: 'bad' }, 'Review'), /typed-kimi:invalid-context/);
});
test('bound completed native structured response yields only owner proposal and observations', async () => {
  const result = await parseSubmission(expected, binding, native());
  assert.deepEqual(result.response, decision);
  assert.deepEqual(result.proposal, { event: 'APPROVE', authority: 'proposal-only' });
  assert.deepEqual(result.observed, { sessionID: binding.sessionID, assistantID: binding.assistantID,
    providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', variant: 'low', completedAt: 123 });
  assert.equal(result.executionControl, undefined);
  assert.equal(result.approved, undefined);
});
test('metadata errors and changed caller session/message binding refuse', async () => {
  for (const patch of [{ role: 'user' }, { providerID: 'other' }, { modelID: 'other' },
    { variant: 'high' }, { variant: undefined }, { error: { name: 'ProviderError' } },
    { id: 'msg_other' }, { sessionID: 'ses_other' }, { time: {} }, { time: { completed: 0 } }]) {
    const response = native(); Object.assign(response.info, patch);
    await assert.rejects(parseSubmission(expected, binding, response), /typed-kimi:/);
  }
  for (const bad of [null, {}, { ...binding, sessionID: '' }, { ...binding, extra: true }]) {
    await assert.rejects(parseSubmission(expected, bad, native()), /typed-kimi:invalid-binding/);
  }
});
test('prose, missing, duplicate, pending and mismatched StructuredOutput evidence refuse', async () => {
  for (const mutate of [r => { r.parts = [{ type: 'text', text: JSON.stringify(decision) }]; },
    r => { r.parts = []; }, r => { r.parts.push(structuredClone(r.parts[0])); },
    r => { r.parts.push({ type: 'tool', tool: 'StructuredOutput', state: { status: 'running' } }); },
    r => { r.parts[0].state.status = 'error'; },
    r => { r.parts[0].state.input.summary = 'Different tool input'; },
    r => { delete r.info.structured; }]) {
    const response = native(); mutate(response);
    await assert.rejects(parseSubmission(expected, binding, response), /typed-kimi:/);
  }
});
test('owner source/decision refusals and v1 incompatibility survive the native wrapper', async () => {
  for (const value of [{ ...decision, head: 'd'.repeat(40) }, { ...decision, version: 1 },
    { ...decision, executionControl: {} }, { ...decision, verdict: 'changes_requested' }]) {
    await assert.rejects(parseSubmission(expected, binding, native(value)), /typed-kimi:/);
  }
  const value = { ...decision, verdict: 'comment', summary: 'Approved. LGTM. No findings.' };
  assert.equal((await parseSubmission(expected, binding, native(value))).proposal.event, 'COMMENT');
  assert.equal((await parseSubmission(expected, binding, native({ ...decision, coverage: 'incomplete' }))).proposal.event, 'COMMENT');
});
