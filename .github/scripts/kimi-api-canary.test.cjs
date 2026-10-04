'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { probe } = require('./kimi-api-canary.cjs');
function fixture(publisher) {
  const head = 'a'.repeat(40);
  const pr = { number: 450, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'o/r' } } };
  const context = { eventName: 'pull_request', repo: { owner: 'o', repo: 'r' }, payload: { repository: { full_name: 'o/r' }, pull_request: structuredClone(pr) } };
  let review, creates = 0, updates = 0; const receipts = [];
  const pulls = {
    get: async () => ({ data: pr }), listReviews: () => {},
    createReview: async args => { creates++; assert.equal(args.event, 'COMMENT'); review = { id: 42, body: args.body, commit_id: args.commit_id, state: 'COMMENTED', user: publisher === 'opencode-agent' ? { login: 'opencode-agent[bot]', id: 219766164, type: 'Bot' } : { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } }; return { data: structuredClone(review) }; },
    updateReview: async args => { updates++; review.body = args.body; },
    getReview: async () => ({ data: structuredClone(review) }),
  };
  return { publisher, context, pr, pulls, receipts, github: { rest: { pulls }, paginate: async () => review ? [structuredClone(review)] : [] },
    write: receipt => receipts.push(structuredClone(receipt)), counts: () => ({ creates, updates }) };
}
test('same-bot create/update/readback and exact-head rerun deduplication', async () => {
  const f = fixture(); const first = await probe(f); assert.equal(first.passed, true);
  assert.equal(f.receipts[0].passed, false); assert.equal(f.receipts[1].exactUtf8Readback, true);
  const second = await probe(f); assert.equal(second.reused, true); assert.deepEqual(f.counts(), { creates: 1, updates: 1 });
  assert.ok(!second.body.includes('kimi-discord-delivered'));
});
test('OpenCode App diagnostic has exact principal, byte readback and rerun dedupe without approval', async () => {
  const f = fixture('opencode-agent');
  const first = await probe(f), second = await probe(f);
  assert.equal(first.passed, true); assert.equal(second.reused, true);
  assert.deepEqual(f.counts(), { creates: 1, updates: 1 });
  assert.equal(first.author, 'opencode-agent[bot]'); assert.equal(first.authorID, 219766164);
  assert.equal(first.authorType, 'Bot'); assert.equal(first.state, 'COMMENTED');
  assert.match(first.body, /DIAGNOSTIC ONLY — NOT A CODE REVIEW OR APPROVAL/);
  assert.equal(first.exactUtf8Readback, true);
});
for (const [name, change] of [
  ['numeric identity', r => r.user.id = 219766164], ['Bot type', r => r.user.type = 'User'],
  ['missing identity', r => delete r.user.id], ['string identity', r => r.user.id = '41898282'],
]) test(`canary rejects mismatched ${name} before updating`, async () => {
  const f = fixture(), create = f.pulls.createReview;
  f.pulls.createReview = async args => { const result = await create(args); change(result.data); return result; };
  await assert.rejects(probe(f), /mismatch/); assert.equal(f.counts().updates, 0);
  assert.equal(f.receipts[0].passed, false);
});
test('canary refuses a changed owner immediately before update', async () => {
  const f = fixture(), read = f.pulls.getReview;
  f.pulls.getReview = async args => { const result = await read(args); result.data.user.id = 219766164; return result; };
  await assert.rejects(probe(f), /mismatch/); assert.equal(f.counts().updates, 0);
});
test('caller cannot enroll arbitrary or model-supplied diagnostic owners', async () => {
  for (const publisher of ['eta-mu-ai', 'any-bot', { login: 'opencode-agent[bot]', id: 219766164, type: 'Bot' }]) {
    const f = fixture(publisher); await assert.rejects(probe(f), /publisher/);
    assert.deepEqual(f.counts(), { creates: 0, updates: 0 });
  }
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

// Execute the workflow adapters, not a second publisher. Until the held runtime
// is merged, local fixtures read its actual immutable Git blobs; hosted use is
// separately refused by the base-ancestry gate. Missing blobs are a test failure.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const runtimeSHA = '2810f4515424a146fe37390fb0baf532cca31236';
const workflow = fs.readFileSync(path.join(root, '.github/workflows/kimi-runner-tests.yml'), 'utf8');
function block(name, kind) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  const value = step?.split(`          ${kind}: |\n`)[1] || step?.split(`        ${kind}: |\n`)[1];
  assert.ok(value, `Missing executable workflow step: ${name}`);
  const indent = kind === 'script' ? 12 : 10;
  return value.split('\n').map(line => line.slice(indent)).join('\n');
}
function gitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-app-canary-'));
  const repo = path.join(dir, 'repo'), temp = path.join(dir, 'temp');
  fs.mkdirSync(repo); fs.mkdirSync(temp);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Canary fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const scripts = path.join(repo, '.github/scripts'); fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['kimi-api-canary.cjs', 'opencode-app-auth.cjs']) {
    fs.writeFileSync(path.join(scripts, name), execFileSync('git', ['show', `${runtimeSHA}:.github/scripts/${name}`], { cwd: root }));
  }
  fs.mkdirSync(path.join(repo, '.github/workflows'));
  fs.writeFileSync(path.join(repo, '.github/workflows/kimi-runner-tests.yml'), workflow);
  git('add', '.'); git('commit', '-qm', 'Actual immutable helper blobs as qualified fixture base');
  const base = git('rev-parse', 'HEAD');
  // Both candidates trip if loaded. The job may inspect their Git data only.
  for (const name of ['kimi-api-canary.cjs', 'opencode-app-auth.cjs']) {
    fs.writeFileSync(path.join(scripts, name), "require('node:fs').writeFileSync(process.env.RUNNER_TEMP + '/candidate-executed', 'bad'); throw Error('candidate executed');\n");
  }
  git('add', '.'); git('commit', '-qm', 'Untrusted PR candidate tripwires');
  const head = git('rev-parse', 'HEAD');
  const env = { ...process.env, GITHUB_WORKSPACE: repo, RUNNER_TEMP: temp, KIMI_RUNTIME_SHA: base,
    PR_HEAD_SHA: head, PR_BASE_SHA: base, PR_NUMBER: '445', GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '700', GITHUB_RUN_ATTEMPT: '2', GITHUB_REF: 'refs/pull/445/merge',
    GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head, GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/kimi-runner-tests.yml@refs/pull/445/merge' };
  return { dir, repo, temp, head, base, git, env, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function prepare(f) {
  // The predecessor has no immutable preparation step; execute that absence
  // as-is so RED witnesses its actual candidate loader, not a missing-step error.
  if (!workflow.includes('      - name: Prepare immutable App diagnostic runtime\n')) return { status: 0, stderr: '' };
  return spawnSync('bash', ['-c', block('Prepare immutable App diagnostic runtime', 'run')], { cwd: f.repo, env: f.env, encoding: 'utf8' });
}
// Only external transports are mocked; both trusted modules and the entire
// extracted workflow script execute unchanged in a fresh process.
async function transportWorker(script, options) {
  const assert = require('node:assert/strict'), fs = require('node:fs');
  const e = process.env, seen = { oidc: 0, exchange: 0, revoke: 0, creates: 0, updates: 0, appClients: 0, masks: 0, reads: 0 };
  const pr = { number: 445, state: 'open', draft: false, head: { sha: e.PR_HEAD_SHA, repo: { full_name: 'o/r' } }, base: { sha: e.PR_BASE_SHA, repo: { full_name: 'o/r' } } };
  const context = { eventName: 'pull_request', repo: { owner: 'o', repo: 'r' }, runId: 700,
    sha: e.GITHUB_SHA, ref: 'refs/pull/445/merge', workflow: 'Kimi runner contract tests',
    payload: { repository: { full_name: 'o/r' }, pull_request: structuredClone(pr) } };
  if (options.contextRun) context.runId++;
  if (options.contextHead) context.payload.pull_request.head.sha = 'b'.repeat(40);
  if (options.liveHead) pr.head.sha = 'b'.repeat(40);
  if (options.liveBase) pr.base.sha = 'b'.repeat(40);
  let review;
  const pulls = {
    get: async () => { seen.reads++; return { data: structuredClone(pr) }; }, listReviews: () => {},
    createReview: async args => {
      seen.creates++; assert.equal(args.event, 'COMMENT');
      review = { id: 912, body: args.body, commit_id: args.commit_id, state: 'COMMENTED',
        user: { login: 'opencode-agent[bot]', id: 219766164, type: 'Bot' } };
      if (options.wrongActor) review.user.id++;
      return { data: structuredClone(review) };
    },
    updateReview: async args => {
      seen.updates++; assert.equal(args.review_id, review.id);
      if (options.updateFailure) throw Error('fixture secret transport details');
      review.body = args.body;
    },
    getReview: async args => { assert.equal(args.review_id, review.id); return { data: structuredClone(review) }; },
  };
  class Github {
    constructor({ auth }) {
      if (auth !== 'read-only-fixture') { assert.equal(auth, 'installation-fixture-not-a-credential'); seen.appClients++; }
      this.rest = { pulls }; this.paginate = async () => review ? [structuredClone(review)] : [];
    }
  }
  const github = new Github({ auth: 'read-only-fixture' });
  const core = { getIDToken: async audience => { assert.equal(audience, 'opencode-github-action'); seen.oidc++; return 'oidc-fixture-not-a-credential'; },
    setSecret: value => { assert.ok(['oidc-fixture-not-a-credential', 'installation-fixture-not-a-credential'].includes(value)); seen.masks++; } };
  global.fetch = async (url, init) => {
    if (url === 'https://api.opencode.ai/exchange_github_app_token') {
      seen.exchange++; assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer oidc-fixture-not-a-credential');
      assert.equal(Object.hasOwn(init, 'body'), false); assert.equal(init.redirect, 'error');
      if (options.moveAfterExchange) pr.head.sha = 'b'.repeat(40);
      return { ok: true, json: async () => ({ token: 'installation-fixture-not-a-credential' }) };
    }
    assert.equal(url, 'https://api.github.com/installation/token'); seen.revoke++;
    assert.equal(init.method, 'DELETE'); assert.equal(init.headers.Authorization, 'Bearer installation-fixture-not-a-credential');
    return { status: options.revokeFailure ? 500 : 204 };
  };
  const execute = () => new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', script)(require, github, context, core);
  let error;
  try { await execute(); if (options.rerun) await execute(); } catch (caught) { error = caught.message; }
  const file = `${e.RUNNER_TEMP}/kimi-api-canary.json`;
  const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  process.stdout.write(JSON.stringify({ seen, receipt, error, tripwire: fs.existsSync(`${e.RUNNER_TEMP}/candidate-executed`) }));
}
function execute(f, options = {}) {
  const name = workflow.includes('      - name: Create or verify exact App diagnostic review\n')
    ? 'Create or verify exact App diagnostic review' : 'Create or verify same-bot diagnostic review';
  const script = block(name, 'script');
  const worker = `(${transportWorker.toString()})(${JSON.stringify(script)}, ${JSON.stringify(options)}).catch(() => process.exit(92))`;
  const result = spawnSync(process.execPath, ['-e', worker], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
test('diagnostic job is fresh, read/OIDC only and shares the held immutable publisher selection', () => {
  const job = workflow.split('\n  native-api-canary:\n')[1]; assert.ok(job);
  assert.match(job, /contents: read\n {6}id-token: write/);
  assert.doesNotMatch(job, /pull-requests: write|issues: write|secrets\.|opencode\/github|npm |npx /);
  assert.doesNotMatch(job, /require\(.*GITHUB_WORKSPACE.*\.github\/scripts/);
  assert.match(job, /ref: \$\{\{ github.event.pull_request.head.sha \}\}\n {10}fetch-depth: 0\n {10}persist-credentials: false/);
  assert.match(workflow, new RegExp(`KIMI_RUNTIME_SHA: ${runtimeSHA}`));
  assert.match(fs.readFileSync(path.join(root, '.github/workflows/opencode-code-review.yml'), 'utf8'), new RegExp(`KIMI_RUNTIME_SHA: ${runtimeSHA}`));
  assert.match(job, /publisher: 'opencode-agent'/);
  assert.match(job, /new github.constructor\(\{ auth: token \}\)/);
  assert.match(job, /withOpenCodeAppToken\(\{ core \}/);
  assert.match(workflow.split('\n  native-api-canary:')[0], /fetch-depth: 0/);
});
test('actual shell and immutable App modules refuse candidate execution, create/readback and dedupe', () => {
  const f = gitFixture(); try {
    const ready = prepare(f); assert.equal(ready.status, 0, ready.stderr);
    const result = execute(f, { rerun: true }); assert.equal(result.error, undefined); assert.equal(result.tripwire, false);
    assert.deepEqual(result.seen, { oidc: 2, exchange: 2, revoke: 2, creates: 1, updates: 1, appClients: 2, masks: 4, reads: 4 });
    const r = result.receipt;
    assert.equal(r.passed, true); assert.equal(r.nativeProbePassed, true); assert.equal(r.revoked, true); assert.equal(r.reused, true);
    assert.equal(r.author, 'opencode-agent[bot]'); assert.equal(r.authorID, 219766164); assert.equal(r.authorType, 'Bot');
    assert.equal(r.reviewID, 912); assert.equal(r.state, 'COMMENTED'); assert.equal(r.commit, f.head); assert.equal(r.head, f.head);
    assert.equal(r.base, f.base); assert.equal(r.runtimeSha, f.base); assert.equal(r.runID, '700'); assert.equal(r.runAttempt, '2');
    assert.equal(r.workflowSha, f.head); assert.equal(r.exactUtf8Readback, true);
    assert.match(r.body, /API DIAGNOSTIC ONLY — NOT A CODE REVIEW OR APPROVAL/);
    assert.match(r.body, /No model judgment, review-round credit/);
    assert.doesNotMatch(JSON.stringify(r), /fixture-not-a-credential|APPROVED/);
  } finally { f.clean(); }
});
test('base ancestry and checked-out head refuse before loading runtime or OIDC', () => {
  for (const fault of ['unqualified', 'checkout']) {
    const f = gitFixture(); try {
      if (fault === 'unqualified') f.env.KIMI_RUNTIME_SHA = f.head;
      else f.git('checkout', '-q', f.base);
      assert.notEqual(prepare(f).status, 0);
      assert.equal(fs.existsSync(path.join(f.temp, 'kimi-api-canary.cjs')), false);
      assert.equal(fs.existsSync(path.join(f.temp, 'candidate-executed')), false);
    } finally { f.clean(); }
  }
});
test('tampering, context drift and live head/base movement all refuse before OIDC', () => {
  for (const fault of ['canary', 'auth', 'workflow', 'contextRun', 'contextHead', 'liveHead', 'liveBase', 'runAttempt', 'workflowRef', 'workflowSHA', 'checkout']) {
    const f = gitFixture(); try {
      assert.equal(prepare(f).status, 0);
      if (['canary', 'auth'].includes(fault)) fs.appendFileSync(path.join(f.temp, fault === 'canary' ? 'kimi-api-canary.cjs' : 'opencode-app-auth.cjs'), '\n// substituted\n');
      if (fault === 'workflow') fs.appendFileSync(path.join(f.repo, '.github/workflows/kimi-runner-tests.yml'), '\n# substituted\n');
      if (fault === 'runAttempt') f.env.GITHUB_RUN_ATTEMPT = '0';
      if (fault === 'workflowRef') f.env.GITHUB_WORKFLOW_REF = 'o/r/.github/workflows/other.yml@refs/pull/445/merge';
      if (fault === 'workflowSHA') f.env.GITHUB_WORKFLOW_SHA = f.base;
      if (fault === 'checkout') f.git('checkout', '-q', f.base);
      const result = execute(f, { [fault]: true }); assert.ok(result.error, fault);
      assert.equal(result.tripwire, false, fault); assert.equal(result.seen.oidc, 0, fault); assert.equal(result.seen.exchange, 0, fault);
      assert.equal(result.seen.creates, 0, fault); assert.equal(result.receipt?.passed, false, fault);
    } finally { f.clean(); }
  }
});
test('publication or revocation failure stays failed, preserves native evidence and sanitizes output', () => {
  for (const fault of ['moveAfterExchange', 'wrongActor', 'updateFailure', 'revokeFailure']) {
    const f = gitFixture(); try {
      assert.equal(prepare(f).status, 0);
      const result = execute(f, { [fault]: true }); assert.ok(result.error, fault);
      assert.equal(result.seen.oidc, 1); assert.equal(result.seen.revoke, 1); assert.equal(result.tripwire, false);
      assert.equal(result.receipt.passed, false); assert.equal(result.receipt.revoked, fault !== 'revokeFailure');
      assert.doesNotMatch(JSON.stringify(result), /fixture-not-a-credential|secret transport details/);
      if (fault === 'revokeFailure') {
        assert.equal(result.receipt.nativeProbePassed, true); assert.equal(result.receipt.exactUtf8Readback, true);
        assert.equal(result.receipt.reviewID, 912); assert.equal(result.receipt.authorID, 219766164);
        assert.equal(result.receipt.failurePhase, 'revocation');
      } else assert.equal(result.receipt.nativeProbePassed, false);
      if (fault === 'moveAfterExchange') assert.equal(result.seen.creates, 0);
    } finally { f.clean(); }
  }
});
