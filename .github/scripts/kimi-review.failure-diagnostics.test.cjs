// SPDX-License-Identifier: GPL-3.0-or-later
// Only mocked local API/process/CLI effects. No model, network, Git or credential use.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const helperPath = process.env.KIMI_DIAGNOSTIC_HELPER || path.join(__dirname, 'kimi-review.cjs');
const helper = require(helperPath);
const head = 'a'.repeat(40);
const coverage = { diffSha256: 'd'.repeat(64), coveredFiles: ['a'] };
const marker = 'SYNTHETIC_PRIVATE_INPUT';
const value = { head, ...coverage, summary: 'Mocked no-findings result', comments: [] };
/**
 * Build the synthetic catalog accepted by the unchanged provider/model/low contract.
 * @returns {Object} Mocked connected-provider and model capability data.
 */
const catalog = () => ({ connected: ['kimi-code-plan-global'], all: [{
  id: 'kimi-code-plan-global', models: { 'kimi-for-coding': {
    id: 'kimi-for-coding', capabilities: { reasoning: true }, api: { npm: '@ai-sdk/openai-compatible' },
    variants: { low: { reasoningEffort: 'low' } },
  } },
}] });
/**
 * Wrap synthetic data in a successful mocked local JSON response.
 * @param {*} body Data returned by the mock's asynchronous JSON reader.
 * @param {number} [status=200] Mocked local HTTP status.
 * @returns {Object} A response-shaped object without a network operation.
 */
const json = (body, status = 200) => ({ ok: true, status,
  /** @returns {Promise<*>} The synthetic response body without parsing or transport. */
  json: async () => body });
/**
 * Create a synthetic error carrying the private-data marker for redaction assertions.
 * @returns {Error} A fixture error containing no actual credential or native event data.
 */
const privateError = () => Error(marker + ': key/session/message/url/header/body/error text');

/**
 * Build mocked server, local API, stream and reporting effects for one branch scenario.
 * @param {string} mode Scenario selecting synthetic responses and failure boundaries.
 * @param {Object} [options={}] Status override and optional report/cancellation failures.
 * @returns {Object} Mock implementations plus observed calls, output and cleanup counters.
 */
function fixture(mode, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const events = [], calls = [], lines = [], kills = [];
  let controller, cancels = 0, submitted = false;
  const stream = new ReadableStream({
    /** @param {ReadableStreamDefaultController} c Fixture controller to retain. @returns {void} */
    start(c) { controller = c; } });
  const readerBody = {
    /** @returns {Object} A mocked reader that observes cancellation without network access. */
    getReader() {
    const reader = stream.getReader();
    return {
      /** @returns {Promise<Object>} The next synthetic stream read result. */
      read: () => reader.read(),
      /** @returns {Promise<*>} The fixture's cancellation result or synthetic rejection. */
      cancel: () => { cancels++; events.push('cancel'); return options.cancelReject ? Promise.reject(privateError()) : reader.cancel(); } };
  } };
  /** @param {string} signal Recorded termination signal. @returns {void} */
  child.kill = signal => { kills.push(signal); events.push(signal); queueMicrotask(() => child.emit('exit', 0)); };
  /**
   * Assert the unchanged server arguments and simulate readiness, startup failure or own abort.
   * @param {string} _command Unexecuted process command.
   * @param {string[]} args Expected local server arguments.
   * @returns {EventEmitter} The synthetic child with fixture output streams.
   */
  const spawn = (_command, args) => {
    assert.deepEqual(Array.from(args), ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0']);
    queueMicrotask(() => {
      child.stderr.write(marker);
      if (mode === 'startup-failed') child.emit('error', privateError());
      else if (mode !== 'startup-abort') child.stdout.write('opencode server listening on http://127.0.0.1:12345\n');
    });
    return child;
  };
  /** @param {*} event Synthetic event to encode as an SSE frame. @returns {void} */
  const frame = event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
  /** @param {string} id Synthetic assistant ID, optionally invalid. @returns {Object} A matching-session event. */
  const assistant = id => ({ type: 'message.updated', properties: { info: { role: 'assistant', id, sessionID: 'ses_test123' } } });
  /**
   * Serve scenario-specific synthetic responses after asserting the fixture's loopback URL.
   * @param {string} url Local API URL inspected only by this mock.
   * @param {Object} request Request options inspected for the unchanged model/schema contract.
   * @returns {Promise<Object>} A mocked response or the selected synthetic rejection.
   */
  const fetch = async (url, request) => {
    assert.ok(url.startsWith('http://127.0.0.1:12345/'), 'Only mocked local calls permitted');
    const endpoint = new URL(url).pathname;
    calls.push(endpoint);
    if (endpoint === '/provider') {
      if (mode === 'provider-http') return { ok: false, status: options.status ?? 403 };
      if (mode === 'provider-fetch') throw privateError();
      if (mode === 'provider-json') return { ok: true, status: 200,
        /** @returns {Promise<never>} Rejects with the synthetic catalog JSON-reader error. */
        json: async () => { throw privateError(); } };
      const data = catalog();
      if (mode === 'capability-invalid') data.connected = [];
      return json(data);
    }
    if (endpoint === '/session') return json({ id: mode === 'session-id-invalid' ? marker : 'ses_test123' });
    if (endpoint === '/event') {
      if (mode === 'event-fetch') throw privateError();
      if (mode === 'event-http') return { ok: false, status: options.status ?? 503 };
      if (mode === 'event-type') return { ok: true, status: 200, headers: new Headers({ 'content-type': marker }), body: readerBody };
      if (mode === 'event-body') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) };
      if (mode === 'event-reader') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: {
        /** @returns {never} Always throws the synthetic reader-acquisition error. */
        getReader() { throw privateError(); } } };
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: readerBody };
    }
    if (endpoint.endsWith('/prompt_async')) {
      const input = JSON.parse(request.body);
      assert.deepEqual(input.model, { providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding' });
      assert.equal(input.variant, 'low'); assert.equal(input.agent, 'kimi-reviewer');
      assert.equal(input.format.type, 'json_schema'); assert.equal(input.format.retryCount, 1);
      assert.equal(input.format.schema.properties.head.const, head);
      assert.deepEqual(input.format.schema.properties.coveredFiles.const, coverage.coveredFiles);
      if (mode === 'prompt-http') return { ok: false, status: 409 };
      if (mode === 'session-error' || mode === 'session-error-no-id')
        frame({ type: 'session.error', properties: { ...(mode === 'session-error' ? { sessionID: 'ses_test123' } : {}), error: { message: marker, status: 429, key: marker } } });
      else if (mode === 'malformed-event') controller.enqueue(new TextEncoder().encode('data: {' + marker + '\n\n'));
      else if (mode === 'oversize-event') controller.enqueue(new TextEncoder().encode(marker + 'x'.repeat(12 * 1024 * 1024 + 1)));
      else if (mode === 'unknown-event-error') frame(null);
      else if (mode === 'reader-rejected') controller.error(privateError());
      else if (mode === 'eof-no-assistant') controller.close();
      else {
        if (mode === 'foreign-session-error') frame({ type: 'session.error', properties: { sessionID: 'ses_other123', error: { message: marker } } });
        frame(assistant(mode === 'assistant-id-invalid' ? marker : 'msg_test123'));
        if (mode === 'eof-incomplete' || mode === 'success-eof') controller.close();
      }
      submitted = true;
      return { ok: true, status: 204 };
    }
    if (endpoint === '/session/status') {
      if (mode === 'own-abort') return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(privateError()), { once: true }));
      if (mode === 'status-invalid') return json([]);
      if (mode === 'status-unknown') return json({ ses_test123: { type: marker } });
      return json({});
    }
    if (endpoint.endsWith('/message/msg_test123')) {
      if (mode === 'event-after-message') { frame({ type: 'session.error', properties: { sessionID: 'ses_test123', error: { message: marker } } }); await Promise.resolve(); }
      if (mode === 'message-id-invalid') return json({ info: { id: marker, sessionID: 'ses_test123' } });
      if (mode === 'message-json') return { ok: true, status: 200,
        /** @returns {Promise<never>} Rejects with the synthetic message JSON-reader error. */
        json: async () => { throw privateError(); } };
      if (mode === 'eof-incomplete') return json({ info: { id: 'msg_test123', sessionID: 'ses_test123', role: 'assistant' } });
      const info = { id: 'msg_test123', sessionID: 'ses_test123', role: 'assistant', providerID: 'kimi-code-plan-global',
        modelID: 'kimi-for-coding', variant: 'low', time: { completed: 1 }, structured: value };
      if (mode === 'structured-invalid') delete info.structured;
      if (mode === 'assistant-error') info.error = { message: marker, status: 429 };
      return json({ info, parts: [{ type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: value } }] });
    }
    assert.fail('Unexpected mocked local endpoint');
  };
  /** @param {string} line Failure diagnostic line to record. @returns {void} May throw the selected sink error. */
  const report = line => { lines.push(line); events.push('diagnostic'); if (options.reportThrows) throw privateError(); };
  return { spawn, fetch, report, child, calls, lines, events, kills,
    /** @returns {number} Observed reader-cancellation calls. */
    get cancels() { return cancels; },
    /** @returns {boolean} Whether the fixture completed its mocked prompt request. */
    get submitted() { return submitted; } };
}

const fields = ['kind', 'version', 'phase', 'reason', 'eventReason', 'elapsedMs', 'ownAbort', 'localStatus',
  'startupReady', 'catalogContractPassed', 'sessionCreated', 'eventSubscriptionValid', 'promptAccepted',
  'assistantSeen', 'streamEnded', 'streamEOF', 'underlyingCause', 'reviewAccepted'];
/**
 * Assert the closed diagnostic schema, safe bounds and redaction for a thrown value.
 * @param {*} error The value rejected by the selected helper under test.
 * @returns {Object} Its validated failure record for branch-specific assertions.
 */
function diagnostic(error) {
  const d = typeof helper.failureDiagnostics === 'function' ? helper.failureDiagnostics(error) : null;
  assert.ok(d, 'A failed immutable helper must gain bounded failure diagnostics');
  assert.deepEqual(Object.keys(d).sort(), fields.toSorted());
  assert.equal(d.kind, 'kimi-review-failure'); assert.equal(d.version, 1);
  assert.equal(d.underlyingCause, 'UNKNOWN'); assert.equal(d.reviewAccepted, false);
  assert.ok(d.elapsedMs === null || Number.isInteger(d.elapsedMs) && d.elapsedMs >= 0 && d.elapsedMs <= 20 * 60 * 1000);
  assert.ok(d.localStatus === null || Number.isInteger(d.localStatus) && d.localStatus >= 100 && d.localStatus <= 599);
  for (const key of ['ownAbort', 'startupReady', 'catalogContractPassed', 'sessionCreated', 'eventSubscriptionValid',
    'promptAccepted', 'assistantSeen', 'streamEnded', 'streamEOF']) assert.equal(typeof d[key], 'boolean');
  assert.ok(!JSON.stringify(d).includes(marker));
  return d;
}

for (const [mode, phase, reason, extra] of [
  ['startup-failed', 'startup', 'SERVER_STARTUP_FAILED', { startupReady: false }],
  ['startup-abort', 'startup', 'OWN_DEADLINE_EXCEEDED', { ownAbort: true }],
  ['provider-http', 'capability', 'LOCAL_API_HTTP_NON_OK', { localStatus: 403, startupReady: true, catalogContractPassed: false }],
  ['provider-fetch', 'capability', 'LOCAL_API_REQUEST_REJECTED', { localStatus: null }],
  ['provider-json', 'capability', 'LOCAL_API_RESPONSE_JSON_INVALID', { localStatus: 200 }],
  ['capability-invalid', 'capability', 'CAPABILITY_CONTRACT_INVALID', { catalogContractPassed: false }],
  ['session-id-invalid', 'session', 'SESSION_ID_INVALID', { catalogContractPassed: true, sessionCreated: false }],
  ['event-fetch', 'events', 'EVENT_REQUEST_REJECTED', { sessionCreated: true, promptAccepted: false }],
  ['event-http', 'events', 'EVENT_HTTP_NON_OK', { localStatus: 503, eventSubscriptionValid: false }],
  ['event-type', 'events', 'EVENT_CONTENT_TYPE_INVALID', { localStatus: 200, promptAccepted: false }],
  ['event-body', 'events', 'EVENT_BODY_MISSING', { localStatus: 200, promptAccepted: false }],
  ['event-reader', 'events', 'EVENT_READER_UNAVAILABLE', { localStatus: 200, promptAccepted: false }],
  ['prompt-http', 'submit', 'LOCAL_API_HTTP_NON_OK', { localStatus: 409, eventSubscriptionValid: true, promptAccepted: false }],
  ['session-error', 'events', 'SESSION_ERROR', { promptAccepted: true, assistantSeen: false, localStatus: null }],
  ['session-error-no-id', 'events', 'SESSION_ERROR', { promptAccepted: true, assistantSeen: false }],
  ['event-after-message', 'events', 'SESSION_ERROR', { promptAccepted: true, assistantSeen: true }],
  ['malformed-event', 'events', 'EVENT_JSON_INVALID', { promptAccepted: true }],
  ['oversize-event', 'events', 'EVENT_FRAME_TOO_LARGE', { promptAccepted: true }],
  ['assistant-id-invalid', 'events', 'ASSISTANT_ID_INVALID', { promptAccepted: true, assistantSeen: false }],
  ['reader-rejected', 'events', 'EVENT_READER_REJECTED', { streamEnded: true, streamEOF: false }],
  ['eof-no-assistant', 'events', 'STREAM_EOF_WITHOUT_ASSISTANT', { streamEOF: true, assistantSeen: false }],
  ['unknown-event-error', 'events', 'UNKNOWN', { streamEnded: true, streamEOF: false }],
  ['eof-incomplete', 'events', 'STREAM_EOF_WITHOUT_COMPLETION', { streamEOF: true, assistantSeen: true }],
  ['status-invalid', 'status', 'LOCAL_SESSION_STATUS_INVALID', { promptAccepted: true }],
  ['status-unknown', 'status', 'LOCAL_SESSION_STATUS_UNKNOWN', { promptAccepted: true }],
  ['message-id-invalid', 'messages', 'ASSISTANT_RESPONSE_ID_INVALID', { assistantSeen: true }],
  ['message-json', 'messages', 'LOCAL_API_RESPONSE_JSON_INVALID', { localStatus: 200 }],
  ['structured-invalid', 'validation', 'STRUCTURED_REVIEW_INVALID', { assistantSeen: true }],
  ['assistant-error', 'validation', 'STRUCTURED_REVIEW_INVALID', { assistantSeen: true, localStatus: null }],
  ['own-abort', 'status', 'OWN_DEADLINE_EXCEEDED', { ownAbort: true, promptAccepted: true }],
]) test('safe diagnostic distinguishes ' + mode, async () => {
  const f = fixture(mode);
  let failure, result;
  try { result = await helper.executeStructured(marker, { OPENCODE_SERVER_PASSWORD: '', KIMI_API_KEY: '' }, '/isolated/workspace', head, coverage,
    { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: mode.includes('abort') ? 20 : 500, pollInterval: 1 }); }
  catch (error) { failure = error; }
  assert.ok(failure, 'Failure must remain rejected'); assert.equal(result, undefined, 'No review returned on failure');
  const d = diagnostic(failure);
  assert.notEqual(d.elapsedMs, null, 'Executed helper supplies its own bounded elapsed duration');
  assert.equal(d.phase, phase); assert.equal(d.reason, reason);
  for (const [key, expected] of Object.entries(extra)) assert.equal(d[key], expected, mode + ': ' + key);
  assert.equal(f.lines.length, 1); assert.ok(f.lines[0].startsWith('Kimi failure diagnostics v1: '));
  assert.ok(Buffer.byteLength(f.lines[0]) <= 1024 && !f.lines[0].includes('\n'), 'One bounded failure-only line');
  assert.deepEqual(JSON.parse(f.lines[0].slice('Kimi failure diagnostics v1: '.length)), d);
  assert.ok(!f.lines.join('').includes(marker)); assert.ok(!failure.message.includes(marker));
  assert.ok(f.events.indexOf('diagnostic') < f.events.indexOf('SIGTERM'), 'Report before child cleanup');
  assert.deepEqual(f.kills, ['SIGTERM']);
  if (d.eventSubscriptionValid) assert.equal(f.cancels, 1);
});

test('invalid local status stays null and cannot import arbitrary numeric/provider metadata', async () => {
  for (const status of ['429', -1, 600, Infinity, NaN, { secret: marker }]) {
    const f = fixture('provider-http', { status }); let error;
    try { await helper.executeStructured('', { OPENCODE_SERVER_PASSWORD: '' }, '/isolated/workspace', head, coverage,
      { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500 }); } catch (e) { error = e; }
    assert.equal(diagnostic(error).localStatus, null);
    assert.ok(!f.lines.join('').includes(marker));
  }
});

test('failure before fetch admission stays UNKNOWN rather than claiming transport rejection', async () => {
  const f = fixture('success'), circular = { private: marker }; circular.self = circular;
  let error;
  try { await helper.executeStructured(circular, { OPENCODE_SERVER_PASSWORD: '' }, '/isolated/workspace', head, coverage,
    { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500 }); } catch (e) { error = e; }
  const d = diagnostic(error);
  assert.equal(d.phase, 'submit'); assert.equal(d.reason, 'UNKNOWN'); assert.equal(d.promptAccepted, false);
  assert.equal(d.localStatus, null); assert.ok(!f.calls.some(endpoint => endpoint.endsWith('/prompt_async')));
  assert.ok(!f.lines.join('').includes(marker)); assert.equal(f.cancels, 1); assert.deepEqual(f.kills, ['SIGTERM']);
});

test('unknown foreign errors cannot forge diagnostic fields or leak getters/messages', () => {
  const hostile = { message: marker, phase: 'events', diagnostics: { reason: marker, localStatus: 429, key: marker } };
  Object.defineProperty(hostile, 'failureDiagnostics', {
    /** @returns {never} Throws if the helper improperly reads this foreign getter. */
    get() { throw privateError(); } });
  const d = diagnostic(hostile);
  assert.equal(d.reason, 'UNKNOWN'); assert.equal(d.phase, 'UNKNOWN'); assert.equal(d.localStatus, null);
  assert.equal(d.ownAbort, false);
  const line = typeof helper.failureDiagnosticLine === 'function' ? helper.failureDiagnosticLine(hostile) : '';
  assert.ok(line.startsWith('Kimi failure diagnostics v1: ')); assert.ok(!line.includes(marker));
  assert.equal(helper.failureMessage(hostile), 'Kimi review failed closed; no submission artifact produced');
});

test('diagnostic writer failure cannot replace failure or bypass cleanup', async () => {
  const f = fixture('session-error', { reportThrows: true }); let error;
  try { await helper.executeStructured('', { OPENCODE_SERVER_PASSWORD: '' }, '/isolated/workspace', head, coverage,
    { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500 }); } catch (e) { error = e; }
  assert.equal(diagnostic(error).reason, 'SESSION_ERROR'); assert.deepEqual(f.kills, ['SIGTERM']); assert.equal(f.cancels, 1);
  assert.ok(!error.message.includes(marker));
});

test('rejected reader cancellation preserves diagnostic failure and still kills the child', async () => {
  const f = fixture('session-error', { cancelReject: true }); let error;
  try { await helper.executeStructured('', { OPENCODE_SERVER_PASSWORD: '' }, '/isolated/workspace', head, coverage,
    { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500 }); } catch (e) { error = e; }
  assert.equal(diagnostic(error).reason, 'SESSION_ERROR'); assert.equal(f.cancels, 1);
  assert.deepEqual(f.kills, ['SIGTERM']); assert.equal(f.lines.length, 1); assert.ok(!f.lines[0].includes(marker));
  assert.ok(f.events.indexOf('diagnostic') < f.events.indexOf('cancel'));
});

test('own elapsed clock clamps without manufacturing a helper abort or provider cause', async () => {
  const actualRequire = createRequire(helperPath);
  for (const [times, expected] of [[[100, -100], 0], [[0, 3e9], 20 * 60 * 1000], [[0, NaN], null]]) {
    const moduleMock = { exports: {} },
      /** @param {string} name Local module name. @returns {*} A module with JSON-normalized cross-realm equality when needed. */
      requireMock = name => name === 'node:util' ?
      {
        /** @param {*} left JSON fixture data. @param {*} right JSON fixture data. @returns {boolean} Cross-realm data equality. */
        isDeepStrictEqual: (left, right) => actualRequire(name).isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))) } : actualRequire(name);
    vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), { module: moduleMock, require: requireMock, Buffer, TextDecoder,
      AbortController, setTimeout, clearTimeout, performance: {
        /** @returns {number} The next selected finite, negative or NaN clock sample. */
        now: () => times.shift() }, console }, { filename: helperPath });
    const candidate = moduleMock.exports, f = fixture('session-error'); let error;
    try { await candidate.executeStructured('', { OPENCODE_SERVER_PASSWORD: '' }, '/isolated/workspace', head, coverage,
      { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500 }); } catch (e) { error = e; }
    assert.equal(typeof candidate.failureDiagnostics, 'function', 'Immutable baseline has no safe elapsed diagnostics');
    const d = candidate.failureDiagnostics(error);
    assert.equal(d.elapsedMs, expected); assert.equal(d.ownAbort, false); assert.equal(d.underlyingCause, 'UNKNOWN');
    assert.equal(d.reason, 'SESSION_ERROR'); assert.deepEqual(f.kills, ['SIGTERM']);
  }
});

for (const mode of ['success', 'success-eof', 'foreign-session-error']) test('success stays review-only: ' + mode, async () => {
  const f = fixture(mode);
  const review = await helper.executeStructured('', { OPENCODE_SERVER_PASSWORD: '', KIMI_API_KEY: '' }, '/isolated/workspace', head, coverage,
    { spawnImpl: f.spawn, fetchImpl: f.fetch, reportFailure: f.report, timeout: 500, pollInterval: 1 });
  const { executionControl, ...actual } = review;
  assert.deepEqual(actual, value); assert.equal(executionControl.underlyingProviderModel, null);
  assert.equal(executionControl.observedAssistantVariant, 'low');
  assert.equal(f.lines.length, 0); assert.deepEqual(f.kills, ['SIGTERM']); assert.equal(f.cancels, 1);
  assert.ok(!Object.hasOwn(review, 'diagnostics')); assert.ok(!Object.hasOwn(review, 'reason'));
  assert.deepEqual(helper.reviewConfig().permission, { '*': 'deny', read: { '*': 'allow', '**/.env': 'deny',
    '**/.env.*': 'deny', '**/*.pem': 'deny', '**/*.key': 'deny' }, glob: 'allow', grep: 'allow', StructuredOutput: 'allow', external_directory: 'deny' });
  assert.equal(helper.REVIEW_TIMEOUT_MS, 20 * 60 * 1000);
});

test('actual CLI failure logs once before disposable deletion and never writes submission', async () => {
  const f = fixture('session-error'), output = [], order = [], writes = [];
  const actualRequire = createRequire(helperPath);
  let finish; const complete = new Promise(resolve => { finish = resolve; });
  const processMock = { env: { PR_HEAD_SHA: head, PR_BASE_SHA: 'b'.repeat(40), RUNNER_TEMP: '/fixture',
    KIMI_REVIEW_FILE: '/fixture/result.json', KIMI_API_KEY: '' } };
  Object.defineProperty(processMock, 'exitCode', {
    /** @param {number} code Expected failed CLI exit code. @returns {void} Completes the fixture. */
    set(code) { assert.equal(code, 1); finish(); } });
  const fsMock = {
    /** @returns {string} A synthetic disposable path without creating a directory. */
    mkdtempSync: () => '/fixture/isolation',
    /** @returns {void} No-op fixture directory creation. */
    mkdirSync() {},
    /** @param {string} file Unwritten submission path to record. @returns {void} */
    writeFileSync(file) { writes.push(file); },
    /** @returns {void} Records disposable cleanup without deleting any actual path. */
    rmSync() { order.push('disposable-cleanup'); } };
  /**
   * Supply synthetic CLI/version and Git results without executing a command.
   * @param {string} command Unexecuted CLI or Git command.
   * @param {string[]} args Arguments selecting the expected synthetic result.
   * @returns {string} Fixture output; unexpected commands or arguments fail the assertion.
   */
  const exec = (command, args) => {
    if (command === 'opencode') return '1.18.34';
    assert.equal(command, 'git');
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'status' || args[0] === 'ls-tree') return '';
    if (args[0] === 'diff') return args.includes('--name-only') ? 'a\0' : '@@ -0,0 +1 @@\n+x';
    assert.fail('Unplanned mocked Git operation');
  };
  const moduleMock = { exports: {} };
  /** @param {string} name Local module name. @returns {*} A mocked effect module or an existing local built-in. */
  const requireMock = name => name === 'node:fs' ? fsMock : name === 'node:child_process' ? { execFileSync: exec, spawn: f.spawn } :
    name === 'node:util' ? {
      /** @param {*} left JSON fixture data. @param {*} right JSON fixture data. @returns {boolean} Cross-realm data equality. */
      isDeepStrictEqual: (left, right) => actualRequire(name).isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))) } :
    name === 'node:crypto' ? { ...actualRequire(name),
      /** @param {number} size Synthetic byte count. @returns {Buffer} Zero bytes without a credential or random source. */
      randomBytes: size => Buffer.alloc(size) } : actualRequire(name);
  requireMock.main = moduleMock;
  vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), { module: moduleMock, require: requireMock,
    process: processMock, console: {
      /** @param {string} line CLI diagnostic or safe primary message to record. @returns {void} */
      error(line) { output.push(line); order.push(line.startsWith('Kimi failure diagnostics v1: ') ? 'diagnostic' : 'error'); } },
    fetch: f.fetch, Buffer, TextDecoder, AbortController, setTimeout, clearTimeout, performance }, { filename: helperPath });
  await complete;
  assert.equal(writes.length, 0); assert.ok(order.indexOf('diagnostic') >= 0);
  assert.ok(order.indexOf('diagnostic') < order.indexOf('disposable-cleanup'));
  assert.equal(output.filter(line => line.startsWith('Kimi failure diagnostics v1: ')).length, 1);
  assert.ok(output.some(line => line === 'Kimi review failed closed at events; no submission artifact produced'));
  assert.ok(!output.join('').includes(marker));
});
