// SPDX-License-Identifier: GPL-3.0-or-later
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertHead, validateReview, discordPayloads } = require('./kimi-review.cjs');
const a = 'a'.repeat(40), b = 'b'.repeat(40);

test('bounded structured execution authenticates local API, rejects prose and cleans up on timeout', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { executeStructured } = require('./kimi-review.cjs');
  const coverage = { diffSha256: 'd'.repeat(64), coveredFiles: ['a'] };
  const value = { head: a, ...coverage, summary: 'No findings', comments: [] };
  function processStub() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); child.emit('exit', 0); };
    queueMicrotask(() => child.stdout.write('opencode server listening on http://127.0.0.1:12345\n'));
    return child;
  }
  for (const mode of ['valid', 'prose', 'timeout']) {
    const child = processStub();
    let calls = 0;
    const api = async (url, options) => {
      assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('opencode:private-local-auth').toString('base64'));
      assert.ok(url.endsWith('?directory=%2Fisolated%2Fworkspace'));
      if (++calls === 1) return { ok: true, json: async () => ({ id: 'ses_test123' }) };
      const request = JSON.parse(options.body);
      assert.equal(request.format.type, 'json_schema');
      if (mode === 'timeout') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret-provider-diagnostic')), { once: true }));
      return { ok: true, json: async () => mode === 'prose' ? { info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding' }, parts: [{ type: 'text', text: 'Looks fine' }] } :
        { info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', structured: value }, parts: [{ type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: value } }] } };
    };
    const result = executeStructured('review', { OPENCODE_SERVER_PASSWORD: 'private-local-auth' }, '/isolated/workspace', a, coverage,
      { spawnImpl: (_command, args, options) => { assert.ok(args.includes('--pure')); assert.equal(options.cwd, '/isolated/workspace'); return child; }, fetchImpl: api, timeout: 30 });
    if (mode === 'valid') assert.deepEqual(await result, value);
    else await assert.rejects(result, error => !error.message.includes('secret') && (mode === 'timeout' ? /bounded 20-minute/.test(error.message) : /no review was published/.test(error.message)));
    assert.deepEqual(child.kills, ['SIGTERM']);
  }
});
test('tracked snapshot omits live secrets, executable agent config and symlink escapes', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { sourceSnapshot } = require('./kimi-review.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-snapshot-test-'));
  const prior = process.cwd();
  try {
    process.chdir(dir); execFileSync('git', ['init', '-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['config', 'user.name', 'test']);
    fs.mkdirSync('.opencode/tools', { recursive: true });
    fs.writeFileSync('.opencode/tools/evil.js', 'must not execute');
    fs.writeFileSync('.env', 'private-not-model-context');
    fs.writeFileSync('AGENTS.md', 'Read-only instructions');
    fs.writeFileSync('source.cljc', '(def safe true)');
    fs.symlinkSync('/etc/passwd', 'escape');
    execFileSync('git', ['add', '--', '.opencode', '.env', 'AGENTS.md', 'source.cljc', 'escape']);
    execFileSync('git', ['commit', '-qm', 'fixture']);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const target = path.join(dir, 'snapshot'); fs.mkdirSync(target);
    sourceSnapshot(head, target);
    assert.equal(fs.readFileSync(path.join(target, 'source.cljc'), 'utf8'), '(def safe true)');
    for (const omitted of ['.env', '.opencode', 'escape', '.git']) assert.equal(fs.existsSync(path.join(target, omitted)), false);
  } finally { process.chdir(prior); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('structured tool submission binds exact head and complete diff coverage, never prose', () => {
  const { parseStructured } = require('./kimi-review.cjs');
  const coverage = { diffSha256: 'd'.repeat(64), coveredFiles: ['.github/workflows/review.yml'] };
  const value = { head: a, ...coverage, summary: 'No actionable findings', comments: [] };
  const response = input => ({ info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', structured: input }, parts: [
    { type: 'text', text: 'Narration is not submission.' },
    { type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input } },
  ] });
  assert.deepEqual(parseStructured(response(value), a, coverage), value);
  for (const bad of [
    { info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding' }, parts: [{ type: 'text', text: JSON.stringify(value) }] },
    { info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', structured: value }, parts: [] },
    { ...response(value), info: { ...response(value).info, modelID: 'different-model' } },
    response({ ...value, head: b }),
    response({ ...value, coveredFiles: [] }),
    response({ ...value, diffSha256: 'e'.repeat(64) }),
    { ...response(value), info: { role: 'assistant', providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding', structured: value, error: { name: 'StructuredOutputError' } } },
  ]) assert.throws(() => parseStructured(bad, a, coverage));
});
test('review API requests schema-enforced tool output within the unchanged timeout budget', () => {
  const { structuredRequest, REVIEW_TIMEOUT_MS } = require('./kimi-review.cjs');
  const coverage = { diffSha256: 'd'.repeat(64), coveredFiles: ['a'] };
  const request = structuredRequest('inspect', a, coverage);
  assert.equal(request.format.type, 'json_schema');
  assert.equal(request.format.schema.properties.head.const, a);
  assert.deepEqual(request.format.schema.properties.coveredFiles.const, ['a']);
  assert.equal(request.format.schema.additionalProperties, false);
  assert.equal(REVIEW_TIMEOUT_MS, 20 * 60 * 1000);
});
test('stale execution and moving publication heads fail closed', () => {
  assertHead(a, a, a);
  assert.throws(() => assertHead(a, b, a));
  assert.throws(() => assertHead(a, a, b));
  assert.throws(() => assertHead('main', 'main'));
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
  fs.writeFileSync(file, JSON.stringify({ head, ...require('./kimi-review.cjs').diffCoverage(head, head), summary: 'ok', comments: [] }, (key, value) => key === 'diff' ? undefined : value));
  let calls = 0;
  const github = { rest: { pulls: { get: async () => ({ data: { state: 'open', draft: false, head: { sha: b, repo: { full_name: 'o/r' } } } }), createReview: async () => { calls++; } } } };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, base: { sha: head }, head: { sha: head, repo: { full_name: 'o/r' } } } } };
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
  fs.writeFileSync(file, JSON.stringify({ head, ...require('./kimi-review.cjs').diffCoverage(head, head), summary: 'ok', comments: [] }, (key, value) => key === 'diff' ? undefined : value));
  const list = () => {};
  const listFiles = () => {};
  const github = { rest: { pulls: {
    get: async () => ({ data: { state: 'open', draft: false, head: { sha: head, repo: { full_name: 'o/r' } } } }),
    createReview: async args => { assert.equal(args.commit_id, head); return { data: { id: 42 } }; },
    listCommentsForReview: list, listFiles,
  } }, paginate: async (method, args) => { if (method === listFiles) return []; assert.equal(method, list); assert.equal(args.review_id, 42); return [{ body: 'Own finding', path: 'a', line: 1 }]; } };
  let sent = 0;
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, base: { sha: head }, head: { sha: head, repo: { full_name: 'o/r' } } } } };
  try {
    await publish({ github, context, file, webhookUrl: 'unused', fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).embeds[0].description, 'Own finding'); sent++; return { ok: true };
    } });
    assert.equal(sent, 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
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


test('Discord 429 retry observes server delay and exhausted retries remain failures', async () => {
  const { sendDiscord } = require('./kimi-review.cjs');
  let calls = 0; const delays = [];
  await sendDiscord('unused', {}, async () => ++calls === 1 ? { status: 429, ok: false, json: async () => ({ retry_after: 0.25 }) } : { ok: true }, async ms => delays.push(ms));
  assert.equal(calls, 2); assert.deepEqual(delays, [250]);
  calls = 0;
  await assert.rejects(sendDiscord('unused', {}, async () => { calls++; return { status: 429, json: async () => ({ retry_after: 0 }) }; }, async () => {}));
  assert.equal(calls, 5);
});
test('live draft or closed PR is rejected before publication', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process'); const { publish } = require('./kimi-review.cjs');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-test-')); const file = path.join(dir, 'review.json');
  fs.writeFileSync(file, JSON.stringify({ head, ...require('./kimi-review.cjs').diffCoverage(head, head), summary: 'ok', comments: [] }, (key, value) => key === 'diff' ? undefined : value));
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, base: { sha: head }, head: { sha: head, repo: { full_name: 'o/r' } } } } };
  try {
    for (const eligibility of [{ state: 'open', draft: true }, { state: 'closed', draft: false }]) {
      const github = { rest: { pulls: { get: async () => ({ data: { ...eligibility, head: { sha: head, repo: { full_name: 'o/r' } } } }), createReview: async () => assert.fail('Must not publish') } } };
      await assert.rejects(publish({ github, context, file }), /became draft, closed/);
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});


test('secret-bearing workflow rejects a runtime present only on the PR branch', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { execFileSync, spawnSync } = require('node:child_process');
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/opencode-code-review.yml'), 'utf8');
  const prepare = workflow.split('      - name: Prepare immutable review runtime\n')[1].split('      - name: Run exact-head')[0];
  const guard = prepare.split('        run: |\n')[1].split('          git show ')[0].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  assert.match(guard, /git merge-base --is-ancestor/);
  assert.match(prepare, /PR_BASE_SHA: \$\{\{ github.event.pull_request.base.sha \}\}/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-trust-test-'));
  try {
    const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']); git(['config', 'user.name', 'test']); git(['config', 'user.email', 'test@example.invalid']);
    git(['commit', '--allow-empty', '-m', 'trusted base']); const base = git(['rev-parse', 'HEAD']);
    git(['commit', '--allow-empty', '-m', 'unreviewed PR runtime']); const prOnly = git(['rev-parse', 'HEAD']);
    const run = runtime => spawnSync('bash', ['-c', guard], { cwd: directory, env: { ...process.env, KIMI_RUNTIME_SHA: runtime, PR_BASE_SHA: base }, encoding: 'utf8' });
    assert.equal(run(base).status, 0);
    assert.notEqual(run(prOnly).status, 0);
    assert.notEqual(run('main').status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
