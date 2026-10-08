// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../..');
const adapterFile = path.join(__dirname, 'kimi-publisher.cjs');
// Configured identities here are synthetic fixtures, never registration evidence.
const fixtureAuthority = { state: 'configured', appID: 700001, installationID: 700002,
  principal: { login: 'synthetic-kimi-fixture[bot]', id: 700003, type: 'Bot' }, repositoryID: 1178288746 };
const fixtureConfig = { authority: fixtureAuthority, publicationRuntime: { sha: 'd'.repeat(40),
  reviewSHA256: shaFile('kimi-review.cjs'), authSHA256: shaFile('opencode-app-auth.cjs'), authoritySHA256: shaFile('kimi-publication-authority.cjs') } };
/**
 * Hash a sibling fixture source file as SHA256, returning a zero digest when it is absent for baseline compatibility.
 */
function shaFile(name) { const file = path.join(__dirname, name); return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '0'.repeat(64); }
/**
 * Compile a local test module with selected require substitutions and return its exports; this is fixture execution, not native qualification.
 */
function loadFixtureModule(file, substitutes) {
  const Module = require('node:module'); const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  const original = m.require.bind(m); m.require = name => Object.hasOwn(substitutes, name) ? substitutes[name] : original(name);
  m._compile(fs.readFileSync(file, 'utf8'), file); return m.exports;
}
const modern = fs.existsSync(adapterFile) ? loadFixtureModule(adapterFile, { './kimi-publication-config.cjs': fixtureConfig }) : null;
/**
 * Load the local publication helper with a synthetic configured actor registry for isolated publisher tests.
 */
function publicationHelper() {
  const registry = loadFixtureModule(path.join(__dirname, 'opencode-app-auth.cjs'), { './kimi-publication-authority.cjs': fixtureAuthority });
  return loadFixtureModule(path.join(__dirname, 'kimi-review.cjs'), { './opencode-app-auth.cjs': registry });
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const base = 'd4d52a39ff1db65ad36e9a429e03489c1208e32d', runtime = '2810f4515424a146fe37390fb0baf532cca31236';
/**
 * Hash exact fixture bytes as a hexadecimal SHA256 digest for synthetic source and artifact bindings.
 */
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
/**
 * Return a structured clone so synthetic API responses do not share mutable fixture objects.
 */
const clone = x => structuredClone(x);
/**
 * Build the synthetic Proxx repository tuple used by publisher admission fixtures; it supplies no native repository evidence.
 */
const repo = () => ({ id: 1178288746, full_name: 'open-hax/proxx', owner: { login: 'open-hax' }, default_branch: 'main' });
const control = { requested: { variant: 'low' }, advertisedNativeControl: { apiNpm: '@ai-sdk/openai-compatible', reasoningEffort: 'low' },
  opencodeVersion: '1.18.34', observedAssistantVariant: 'low', executedIdentity: { providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding' },
  underlyingProviderModel: null, binding: 'Pinned OpenCode catalog low mapping and assistant variant; not a provider reasoning-budget attestation' };
/**
 * Wrap fixture bytes in a Base64 file response with their Git blob SHA1 for source-admission tests.
 */
function source(bytes, file) { return { type: 'file', path: file, encoding: 'base64', content: bytes.toString('base64'),
  sha: crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex') }; }
/**
 * Package the supplied review and provenance bytes under the two expected JSON member names and return the fixture ZIP bytes.
 */
function zip(directory, reviewBytes, provenanceBytes) {
  const a = path.join(directory, 'zip-review'), b = path.join(directory, 'zip-provenance'), z = path.join(directory, 'fixture.zip');
  fs.writeFileSync(a, reviewBytes); fs.writeFileSync(b, provenanceBytes);
  execFileSync('python3', ['-c', "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[3],'w',zipfile.ZIP_DEFLATED) as z:\n z.write(sys.argv[1],'kimi-review.json'); z.write(sys.argv[2],'kimi-provenance.json')", a, b, z]);
  return fs.readFileSync(z);
}
/**
 * Build disposable trusted-helper and publication fixtures with synthetic producer, consumer, artifact, API and token effects, plus an explicit cleanup callback.
 */
function fixture(pa = 1, ca = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-two-run-test-')), trusted = path.join(dir, 'trusted');fs.mkdirSync(trusted);
  for (const file of ['kimi-review.cjs', 'opencode-app-auth.cjs']) fs.writeFileSync(path.join(trusted, file),
    execFileSync('git', ['show', `${runtime}:.github/scripts/${file}`]));
  const publication = path.join(dir, 'publication');fs.mkdirSync(publication);
  if(modern) for(const file of ['kimi-review.cjs','opencode-app-auth.cjs','kimi-publication-authority.cjs'])
    fs.copyFileSync(path.join(__dirname,file),path.join(publication,file));
  const helper = require(path.join(trusted, 'kimi-review.cjs')), full = helper.diffCoverage(base, head);
  const model = { providerID: 'kimi-code-plan-global', modelID: 'kimi-for-coding' };
  const review = { head, diffSha256: full.diffSha256, coveredFiles: full.coveredFiles,
    summary: 'Synthetic transport test only; never native review or approval evidence.', comments: [], executionControl: control };
  const modelSha = 'f'.repeat(40), defaultSha = 'e'.repeat(40), name = `kimi-native-101-452-${head}-${pa}`;
  const provenance = { origin: 'github-actions-native-execution', repository: 'open-hax/proxx', prNumber: 452, artifactName: name,
    head, base, runtimeSha: runtime, runtimeBlobSha256: sha(fs.readFileSync(path.join(trusted, 'kimi-review.cjs'))), runtimeBaseAncestorVerified: true,
    authBlobSha256: sha(fs.readFileSync(path.join(trusted, 'opencode-app-auth.cjs'))), reviewBlobSha256: sha(Buffer.from(JSON.stringify(review))),
    executionControl: control, requestedModel: model, executedModel: model,
    executedModelBinding: 'Successful immutable parseStructured requires assistant providerID/modelID to equal requested Kimi identities',
    runID: '101', runAttempt: pa, runURL: 'https://github.com/open-hax/proxx/actions/runs/101', workflowSha: modelSha,
    workflowRef: 'open-hax/proxx/.github/workflows/opencode-code-review.yml@refs/pull/452/merge', opencodeVersion: '1.18.34',
    archiveSha256: '0f22479647226d1d2dd99595d20082ee7bda3870b62dc6a90b41efc1a71d7e9a', diffSha256: full.diffSha256, coveredFiles: full.coveredFiles };
  const pr = { number: 452, state: 'open', draft: false, merge_commit_sha: modelSha,
    head: { sha: head, repo: repo() }, base: { sha: base, repo: repo() } };
  const producer = { id: 101, run_attempt: pa, workflow_id: 285819940, event: 'pull_request', path: '.github/workflows/opencode-code-review.yml',
    repository: repo(), head_repository: repo(), head_sha: head, status: 'completed', conclusion: 'success',
    pull_requests: [{ number: 452, head: { sha: head }, base: { sha: base } }] };
  const consumer = { id: 201, run_attempt: ca, workflow_id: 999, event: 'workflow_run', path: '.github/workflows/opencode-kimi-publish.yml',
    repository: repo(), head_repository: repo(), head_sha: defaultSha, status: 'in_progress' };
  const steps = ['Run exact-head Kimi review without publication credentials', 'Record native execution provenance', 'Preserve native submission and its execution provenance']
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const jobs = [{ id: 301, run_id: 101, run_attempt: pa, head_sha: head, name: 'Produce exact-head Kimi review', status: 'completed', conclusion: 'success', steps },
    { id: 302, run_id: 101, run_attempt: pa, head_sha: head, name: 'Review runner regression tests', status: 'completed', conclusion: 'success', steps: [] }];
  const f = { dir, trusted, publication, helper, review, provenance, pr, producer, consumer, jobs, repo: repo(), defaultSha, modelSha, name,
    counts: { mint: 0, post: 0, revoke: 0, downloads: 0 }, native: [], attempts: [], apiTrace: [], mutations: {},
    workflow: { id: 285819940, path: '.github/workflows/opencode-code-review.yml', name: 'OpenCode Kimi PR Review', state: 'active' },
    consumerWorkflow: { id: 999, path: '.github/workflows/opencode-kimi-publish.yml', name: 'Trusted OpenCode Kimi PR Publication', state: 'active' },
    context: { payload: { action: 'completed', repository: repo(), workflow_run: clone(producer) } },
    env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: String(ca),
      GITHUB_SHA: defaultSha, KIMI_PUBLISHER_WORKFLOW_SHA: defaultSha,
      KIMI_PUBLISHER_WORKFLOW_REF: 'open-hax/proxx/.github/workflows/opencode-kimi-publish.yml@refs/heads/main',
      KIMI_PUBLISHER_AUTHORIZATION: 'owned-kimi-v1-qualified', KIMI_PUBLICATION_READBACK: path.join(dir, 'checkpoint.json') } };
  f.refresh = () => { f.zip = zip(dir, Buffer.from(JSON.stringify(f.review)), Buffer.from(JSON.stringify(f.provenance)));
    f.artifacts = [{ id: 401, name, size_in_bytes: f.zip.length, expired: false, digest: `sha256:${sha(f.zip)}`, workflow_run: { id: 101, head_sha: head } }]; };
  f.refresh();
  const files = /** Identify the synthetic list-files pagination route; the fixture paginate callback supplies its result. */ () => {}, reviews = /** Identify the synthetic list-reviews pagination route; the fixture paginate callback supplies its result. */ () => {}, comments = /** Identify the synthetic inline-comment pagination route; the fixture paginate callback supplies its result. */ () => {};
  f.app = { rest: { pulls: { get: async () => ({ data: clone(f.pr) }), listFiles: files, listReviews: reviews, listCommentsForReview: comments,
    createReview: async x => { f.counts.post++; if (f.postFailure) throw Error('Synthetic POST failure');
      const r = { id: f.missingNativeID ? undefined : 7004, html_url: 'https://github.com/open-hax/proxx/pull/452#pullrequestreview-7004',
      commit_id: x.commit_id, body: x.body, state: 'COMMENTED', user: modern ? clone(fixtureAuthority.principal) : { login: 'opencode-agent[bot]', id: 219766164, type: 'Bot' } };
      f.native.push(r);if (f.afterPost) f.afterPost();return { data: clone(r) }; },
    getReview: async () => { if (f.readbackFailure) throw Error('synthetic readback failure'); return { data: clone(f.native[0]) }; },
    updateReview: async x => { f.native[0].body = x.body; return { data: clone(f.native[0]) }; } } },
    paginate: async method => method === files ? [] : method === reviews ? clone(f.native) : [] };
  f.api = async endpoint => {
    f.apiTrace.push(endpoint);
    if (f.failAPI) throw Error('Synthetic bounded read failure');
    if (endpoint === 'repos/open-hax/proxx') { f.cycles=(f.cycles||0)+1;if(f.cycles===2 && f.beforeFresh) f.beforeFresh();return clone(f.repo); }
    if (endpoint.endsWith('/actions/runs/101')) return clone(f.producer);
    if (endpoint.endsWith('/actions/runs/201')) return clone(f.consumer);
    if (/\/pulls\/\d+$/.test(endpoint)) return clone(f.pr);
    if (endpoint.endsWith('/actions/workflows/285819940')) return clone(f.workflow);
    if (endpoint.includes('/actions/workflows/.github%2F')) return clone(f.consumerWorkflow);
    if (endpoint.includes('/git/ref/heads/')) return { object: { sha: f.defaultRef || defaultSha } };
    if (endpoint.includes('/jobs?')) return { total_count: f.jobs.length, jobs: clone(f.jobs) };
    if (endpoint.includes('/artifacts?')) return { total_count: f.artifacts.length, artifacts: clone(f.artifacts) };
    if (endpoint.includes('/compare/')) return { status: f.badRuntimeAncestry ? 'diverged' : 'ahead', merge_base_commit: { sha: fixtureConfig.publicationRuntime.sha } };
    if (endpoint.includes('/commits/')) return { sha: f.mergeSha || modelSha, parents: [{ sha: base }, { sha: head }] };
    if (endpoint.includes('/contents/')) {
      const file = endpoint.split('/contents/')[1].split('?')[0];
      const filePath = path.join(workspace, file);
      const bytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('absent baseline publisher');
      return source(f.badSource ? Buffer.concat([bytes, Buffer.from('\nchanged')]) : bytes, file);
    }
    throw Error('Unexpected synthetic read endpoint');
  };
  f.options = () => ({ core: {}, context: f.context, env: f.env, github: {}, effects: {
    api: f.api, sourceHead: () => f.checkedOutSha || defaultSha,
    download: async () => { f.counts.downloads++; return f.zip; },
    prepare: () => ({ directory: workspace, trusted, publication, helper: f.helper, publicationHelper: modern ? publicationHelper() : f.helper, ancestor: f.ancestor !== false }),
    withToken: async (_opts, use) => { f.counts.mint++; if (f.duringMint) f.duringMint();
      try { return await use('synthetic-noncredential'); } finally { f.counts.revoke++; if (f.revokeFailure) throw Error('synthetic revoke failure'); } },
    appClient: () => f.app } });
  f.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return f;
}
// On immutable a443, run the actual inline caller under synthetic external effects.
// This exposes pre-mint missing native consumer admission, not a missing import.
/**
 * Extract and execute the checked-in legacy inline publisher with synthetic external effects to exercise its historical admission boundary.
 */
async function legacyRun(f) {
  const yaml = fs.readFileSync(path.join(workspace, '.github/workflows/opencode-code-review.yml'), 'utf8');
  const script = yaml.split('          script: |\n')[1]; assert.ok(script, 'Actual a443 inline publisher must be present');
  const code = script.split('\n').map(x => x.startsWith('            ') ? x.slice(12) : x).join('\n');
  fs.copyFileSync(path.join(f.trusted, 'kimi-review.cjs'), path.join(f.dir, 'kimi-review.cjs'));
  fs.copyFileSync(path.join(f.trusted, 'opencode-app-auth.cjs'), path.join(f.dir, 'opencode-app-auth.cjs'));
  const file = path.join(f.dir, 'kimi-review.json'); fs.writeFileSync(file, JSON.stringify(f.review));
  fs.mkdirSync(path.join(f.dir, 'kimi-native'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'kimi-native/kimi-provenance.json'), JSON.stringify(f.provenance));
  const e = { ...f.env, RUNNER_TEMP: f.dir, PR_HEAD_SHA: head, PR_BASE_SHA: base, KIMI_RUNTIME_SHA: runtime,
    PR_NUMBER: '452', GITHUB_REPOSITORY: 'open-hax/proxx', GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: String(f.producer.run_attempt),
    GITHUB_SERVER_URL: 'https://github.com', REVIEW_WORKFLOW_SHA: f.modelSha,
    REVIEW_WORKFLOW_REF: f.provenance.workflowRef, ARTIFACT_NAME: f.name, KIMI_REVIEW_FILE: file };
  /**
   * Substitute fixture token and review helpers for the legacy caller while delegating other module loads to require.
   */
  const req = name => name.endsWith('/opencode-app-auth.cjs') ? { withOpenCodeAppToken: f.options().effects.withToken } :
    name.endsWith('/kimi-review.cjs') ? f.helper : require(name);
  /**
   * Return the synthetic App client when the legacy caller constructs its publication client.
   */
  const Constructor = function () { return f.app; };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('require', 'process', 'context', 'github', 'core', 'fetch', 'AbortSignal', code)
    (req, { env: e }, { repo: { owner: 'open-hax', repo: 'proxx' }, payload: { pull_request: clone(f.pr) } },
      { constructor: Constructor }, {}, async () => { throw Error('No live fetch'); }, AbortSignal);
}
/**
 * Run the current publisher adapter when present, otherwise exercise the legacy inline workflow through the same fixture.
 */
const run = f => modern ? modern.run(f.options()) : legacyRun(f);
test('actual PR producer contains no App/OIDC publication; consumer uses reviewed default source', () => {
  const reader = fs.readFileSync(path.join(workspace, '.github/workflows/opencode-code-review.yml'), 'utf8');
  assert.doesNotMatch(reader, /id-token:\s*write|withOpenCodeAppToken|\n  publish:/);
  const writer = fs.readFileSync(path.join(workspace, '.github/workflows/opencode-kimi-publish.yml'), 'utf8');
  assert.match(writer, /workflow_run:/);assert.match(writer, /types: \[completed\]/);assert.match(writer, /ref: \$\{\{ github.sha \}\}/);
  assert.match(writer, /owned-kimi-v1-qualified/);assert.match(writer, /environment: proxx-kimi-publish/);assert.doesNotMatch(writer, /id-token:\s*write/);assert.doesNotMatch(writer, /cancel-in-progress: true|KIMI_API_KEY|restore-cache|pull_request.head.sha/);
  assert.match(writer, /if: \$\{\{ always\(\) \}\}/);assert.match(writer, /if-no-files-found: error/);
});
for (const [pa, ca] of [[1, 1], [1, 2], [2, 1]]) test(`actual consumer preserves producer${pa}/consumer${ca} separately`, async () => {
  const f = fixture(pa, ca);try {
    const b = await run(f);assert.equal(b['producer-id'],101);assert.equal(b['consumer-id'],201);
    assert.equal(b['producer-attempt'],pa);assert.equal(b['consumer-attempt'],ca);
    assert.equal(f.counts.mint,1);assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,1);
    const body = f.native[0].body;assert.match(body, /"runID": "101"/);assert.match(body, /"publication":/);assert.match(body, /"runID": "201"/);
    assert.equal(JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK)).stage,'complete');
  } finally { f.cleanup(); }
});
const negatives = [
  ['non-MAIN default branch',f=>f.repo.default_branch='staging'], ['publication helper outside MAIN ancestry',f=>f.badRuntimeAncestry=true],
  ['wrong producer workflow ID',f=>f.producer.workflow_id=42], ['wrong producer path',f=>f.producer.path='.github/workflows/lookalike.yml'],
  ['wrong producer event',f=>f.producer.event='pull_request_target'], ['wrong repository ID',f=>f.producer.repository.id=42],
  ['wrong repository owner',f=>f.producer.repository.owner.login='someone'], ['foreign head repository',f=>f.producer.head_repository.id=42],
  ['changed head',f=>f.pr.head.sha='a'.repeat(40)], ['changed base',f=>f.pr.base.sha='b'.repeat(40)], ['draft',f=>f.pr.draft=true],
  ['closed',f=>f.pr.state='closed'], ['missing PR association',f=>f.producer.pull_requests=[]],
  ['ambiguous PR association',f=>f.producer.pull_requests.push(clone(f.producer.pull_requests[0]))],
  ['failed producer',f=>f.producer.conclusion='failure'], ['incomplete producer',f=>f.producer.status='in_progress'],
  ['failed producer job',f=>f.jobs[0].conclusion='failure'], ['skipped producer upload',f=>f.jobs[0].steps[2].conclusion='skipped'],
  ['missing producer upload',f=>f.jobs[0].steps.pop()], ['wrong producer job attempt',f=>f.jobs[0].run_attempt++],
  ['failed runner',f=>f.jobs[1].conclusion='failure'], ['wrong consumer workflow ID',f=>f.consumer.workflow_id=123],
  ['wrong consumer event',f=>f.consumer.event='pull_request'], ['wrong consumer attempt',f=>f.consumer.run_attempt++],
  ['canceled consumer',f=>f.consumer.status='completed'], ['lookalike consumer name',f=>f.consumerWorkflow.name='lookalike'],
  ['wrong trigger head',f=>f.context.payload.workflow_run.head_sha='a'.repeat(40)],
  ['changed default source',f=>f.defaultRef='a'.repeat(40)], ['wrong checked-out source',f=>f.checkedOutSha='a'.repeat(40)],
  ['changed observed source bytes',f=>f.badSource=true], ['changed native merge source',f=>f.mergeSha='a'.repeat(40)],
  ['missing artifact',f=>f.artifacts=[]], ['ambiguous artifact',f=>f.artifacts.push({...f.artifacts[0],id:402})],
  ['empty artifact name',f=>f.artifacts[0].name=''], ['foreign artifact run',f=>f.artifacts[0].workflow_run.id=42],
  ['wrong artifact head',f=>f.artifacts[0].workflow_run.head_sha='a'.repeat(40)], ['expired artifact',f=>f.artifacts[0].expired=true],
  ['oversized artifact',f=>f.artifacts[0].size_in_bytes=2097153], ['wrong archive digest',f=>f.artifacts[0].digest='sha256:'+'0'.repeat(64)],
  ['wrong producer provenance attempt',f=>{f.provenance.runAttempt++;f.refresh();}],
  ['missing declared artifact output',f=>{f.provenance.artifactName='';f.refresh();}],
  ['conflated consumer provenance run',f=>{f.provenance.runID='201';f.refresh();}],
  ['wrong immutable auth claim',f=>{f.provenance.authBlobSha256='0'.repeat(64);f.refresh();}],
  ['wrong native low control',f=>{f.review.executionControl={...control,observedAssistantVariant:'max'};f.provenance.reviewBlobSha256=sha(Buffer.from(JSON.stringify(f.review)));f.refresh();}],
  ['unexpected provenance field',f=>{f.provenance.command='never execute';f.refresh();}],
  ['extra review field',f=>{f.review.extra=true;f.provenance.reviewBlobSha256=sha(Buffer.from(JSON.stringify(f.review)));f.refresh();}],
  ['incomplete covered files',f=>{f.review.coveredFiles=f.review.coveredFiles.slice(1);f.provenance.reviewBlobSha256=sha(Buffer.from(JSON.stringify(f.review)));f.refresh();}],
  ['invalid UTF8 member',f=>{f.zip=zip(f.dir,Buffer.from([0xff]),Buffer.from(JSON.stringify(f.provenance)));f.artifacts[0].size_in_bytes=f.zip.length;f.artifacts[0].digest='sha256:'+sha(f.zip);}],
  ['missing runtime ancestry',f=>f.ancestor=false], ['missing qualified activation acknowledgement',f=>f.env.KIMI_PUBLISHER_AUTHORIZATION=''],
  ['wrong consumer ref',f=>f.env.KIMI_PUBLISHER_WORKFLOW_REF='open-hax/proxx/.github/workflows/opencode-kimi-publish.yml@refs/pull/452/merge'],
  ['malformed producer attempt',f=>f.producer.run_attempt=0], ['missing runner job',f=>f.jobs.pop()],
  ['missing native artifact digest',f=>delete f.artifacts[0].digest],
  ['fresh base before mint',f=>f.beforeFresh=()=>{f.pr.base.sha='b'.repeat(40);}],
  ['fresh default source before mint',f=>f.beforeFresh=()=>{f.defaultRef='b'.repeat(40);}],
  ['fresh producer attempt before mint',f=>f.beforeFresh=()=>{f.producer.run_attempt=2;}],
];
for (const [name,mutate] of negatives) test(`actual caller rejects ${name} before mint/POST`, async () => {
  const f=fixture();try { mutate(f);let rejected=false;try{await run(f);}catch{rejected=true;}
    assert.equal(f.counts.mint,0,'native admission must refuse before mint');assert.equal(f.counts.post,0);assert.equal(rejected,true); }
  finally { f.cleanup(); }
});
for (const when of ['duringMint','afterPost']) test(`fresh source/base guard ${when} retains truthful publication checkpoint`, async () => {
  const f=fixture();try {f[when]=()=>{f.pr.base.sha='b'.repeat(40);};await assert.rejects(run(f));assert.equal(f.counts.mint,1);assert.equal(f.counts.revoke,1);
    assert.equal(f.counts.post,when==='afterPost'?1:0);const c=JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK));
    assert.equal(c.stage,when==='afterPost'?'published-not-reconciled':'not-established');if(when==='afterPost')assert.equal(c.id,7004);
  }finally{f.cleanup();}
});
test('actual same-workspace retry refusal preserves known native ID',async()=>{const f=fixture();try{
  const prior={stage:'published-not-reconciled',id:7004,head};fs.writeFileSync(f.env.KIMI_PUBLICATION_READBACK,JSON.stringify(prior));
  f.failAPI=true;await assert.rejects(run(f));assert.deepEqual(JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK)),prior);assert.equal(f.counts.mint,0);
}finally{f.cleanup();}});
test('actual readback failure retains native ID and revokes',async()=>{const f=fixture();try{
 f.readbackFailure=true;await assert.rejects(run(f));assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,1);
 const c=JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK));assert.equal(c.id,7004);assert.equal(c.stage,'published-not-reconciled');
}finally{f.cleanup();}});
test('actual revocation failure cannot claim complete',async()=>{const f=fixture();try{
 f.revokeFailure=true;await assert.rejects(run(f));assert.equal(f.counts.post,1);assert.equal(JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK)).stage,'published-not-reconciled');
}finally{f.cleanup();}});
for (const [name, mutate] of [
  ['head', f => { f.pr.head.sha = 'b'.repeat(40); }],
  ['base', f => { f.pr.base.sha = 'b'.repeat(40); }],
  ['default source', f => { f.defaultRef = 'b'.repeat(40); }],
  ['unchanged binding', null],
]) test(`completion after successful awaited revocation rechecks ${name}`, { timeout: 10000 }, async () => {
  const f = fixture(); let releaseRevoke;
  try {
    const registry = loadFixtureModule(path.join(__dirname, 'opencode-app-auth.cjs'), { './kimi-publication-authority.cjs': fixtureAuthority });
    const auth = loadFixtureModule(path.join(__dirname, 'proxx-kimi-app-auth.cjs'), {
      './kimi-publication-config.cjs': fixtureConfig, './opencode-app-auth.cjs': registry,
    });
    let beginRevoke, keyReads = 0, revoked = false;
    const deleting = new Promise(resolve => { beginRevoke = resolve; });
    const options = f.options();
    options.effects.withToken = (opts, use) => auth.withOwnedKimiToken({ ...opts,
      core: { setSecret() {} }, now: () => 2000000000,
      readKey: () => { keyReads++; return 'synthetic-key-not-a-credential'; },
      sign: () => 'synthetic-jwt-not-a-credential',
      fetchImpl: async (url, request) => {
        if (request.method === 'POST') {
          assert.equal(url, 'https://api.github.com/app/installations/700002/access_tokens');
          assert.deepEqual(JSON.parse(request.body), { repository_ids: [1178288746], permissions: { metadata: 'read', pull_requests: 'write' } });
          f.counts.mint++;
          return { ok: true, json: async () => ({ token: 'synthetic-noncredential', expires_at: '2033-05-18T04:33:20.000Z',
            repository_selection: 'selected', repositories: [repo()], permissions: { metadata: 'read', pull_requests: 'write' } }) };
        }
        assert.equal(request.method, 'DELETE'); assert.equal(url, 'https://api.github.com/installation/token');
        const released = new Promise(resolve => { releaseRevoke = resolve; }); beginRevoke();
        await released; f.counts.revoke++; revoked = true; return { status: 204 };
      },
    }, use);
    const operation = modern.run(options).then(() => false, () => true);
    await deleting;
    const before = JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK));
    assert.equal(before.id, 7004); assert.equal(before.stage, 'published-not-reconciled');
    if (mutate) mutate(f);
    releaseRevoke();
    assert.equal(await operation, Boolean(mutate), 'completion must refuse a binding changed during successful revocation');
    assert.equal(revoked, true); assert.equal(keyReads, 1);
    assert.equal(f.counts.mint, 1); assert.equal(f.counts.post, 1); assert.equal(f.counts.revoke, 1);
    const after = JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK));
    assert.equal(after.id, 7004); assert.equal(after.stage, mutate ? 'published-not-reconciled' : 'complete');
    if (mutate) assert.equal(Object.hasOwn(after, 'operationConsumerRunID'), false);
  } finally { releaseRevoke?.(); f.cleanup(); }
});
test('actual contract CI includes owned publisher/auth suites and their source triggers', () => {
  const workflow = fs.readFileSync(path.join(workspace, '.github/workflows/kimi-runner-tests.yml'), 'utf8');
  const command = workflow.match(/- run: node --test ([^\n]+)/)?.[1].split(/\s+/);
  assert.deepEqual(command, ['.github/scripts/kimi-review.test.cjs', '.github/scripts/kimi-api-canary.test.cjs',
    '.github/scripts/opencode-app-auth.test.cjs', '.github/scripts/kimi-publisher.test.cjs', '.github/scripts/proxx-kimi-app-auth.test.cjs', '.github/scripts/kimi-review.failure-diagnostics.test.cjs']);
  assert.match(workflow, /npm ci --prefix \.github\/assessment-tools --ignore-scripts --no-audit --no-fund/);
  const filters = workflow.split('\npermissions:')[0];
  for (const file of ['kimi-publication-authority.cjs', 'kimi-publication-config.cjs', 'kimi-publisher.cjs', 'kimi-publisher.test.cjs',
    'kimi_publisher_bridge.cljs', 'kimi_publisher_law.cljc', 'proxx-kimi-app-auth.cjs', 'proxx-kimi-app-auth.test.cjs', 'kimi-review.failure-diagnostics.test.cjs']) {
    assert.equal(filters.split(`'.github/scripts/${file}'`).length - 1, 2, `Both native trigger filters must cover ${file}`);
  }
  for (const file of ['.github/assessment-tools/package.json', '.github/assessment-tools/package-lock.json',
    '.github/workflows/opencode-code-review.yml', '.github/workflows/opencode-kimi-publish.yml']) {
    assert.equal(filters.split(`'${file}'`).length - 1, 2, `Both native trigger filters must cover ${file}`);
  }
});
test('actual missing checkpoint destination refuses before mint',async()=>{const f=fixture();try{
 delete f.env.KIMI_PUBLICATION_READBACK;await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
}finally{f.cleanup();}});
test('actual identical retry deduplicates native review and retains original body',async()=>{const f=fixture();try{
 await run(f);const body=f.native[0].body;f.consumer.run_attempt=2;f.env.GITHUB_RUN_ATTEMPT='2';await run(f);
 assert.equal(f.counts.mint,2);assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,2);assert.equal(f.native[0].body,body);
}finally{f.cleanup();}});
for(const key of ['postFailure','missingNativeID'])test(`actual ${key} leaves neutral checkpoint and revokes`,async()=>{const f=fixture();try{
 f[key]=true;await assert.rejects(run(f));assert.equal(f.counts.mint,1);assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,1);
 assert.equal(JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK)).stage,'not-established');
}finally{f.cleanup();}});
test('actual raw coverage mutation with unchanged declared hash/files refuses before mint',async()=>{const f=fixture();try{
 const original=f.helper.diffCoverage;let calls=0;f.helper.diffCoverage=(...a)=>{const value=original(...a);calls++;return calls>=2?{...value,diff:value.diff+'changed raw diff'}:value;};
 await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
}finally{f.cleanup();}});
test('actual caller checks the pinned runtime request control before mint',async()=>{const f=fixture();try{
 const original=f.helper.structuredRequest;f.helper.structuredRequest=(...a)=>({...original(...a),variant:'max'});
 await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
}finally{f.cleanup();}});
test('JSON artifact instructions remain data and never execute',async()=>{const f=fixture();try{
 globalThis.kimiArtifactTrap=0;f.review.summary='globalThis.kimiArtifactTrap = 1; this is only inert review text.';
 f.provenance.reviewBlobSha256=sha(Buffer.from(JSON.stringify(f.review)));f.refresh();await run(f);
 assert.equal(globalThis.kimiArtifactTrap,0);assert.match(f.native[0].body,/kimiArtifactTrap/);
}finally{delete globalThis.kimiArtifactTrap;f.cleanup();}});
test('bare Git head/base/281 are genuine; uncommitted publication successor uses an explicit fixture show seam',async()=>{const f=fixture();try{
 assert.ok(modern,'Immutable a443 has no isolated trusted consumer');
 const options=f.options();let data;
 options.effects.prepare=(binding,ws,root)=>{
  const args=[];const result=modern.prepare(binding,ws,root,a=>{args.push(a);
   if(a.includes('show') && a.at(-1).startsWith(fixtureConfig.publicationRuntime.sha+':')) return fs.readFileSync(path.join(workspace,a.at(-1).split(':')[1]));
   return execFileSync('git',
   a.map(x=>x==='https://github.com/open-hax/proxx.git'?workspace:x===fixtureConfig.publicationRuntime.sha?head:x),{maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});});
  assert.equal(execFileSync('git',['-C',result.directory,'rev-parse','--is-bare-repository'],{encoding:'utf8'}).trim(),'true');
  assert.equal(fs.existsSync(path.join(result.directory,'package.json')),false);
  assert.equal(args.some(a=>a.includes('checkout')),false);
  assert.equal(fs.readFileSync(path.join(result.directory,'HEAD'),'utf8').trim(),head);data=result.directory;result.publicationHelper=publicationHelper();return result;
 };
 await modern.run(options);assert.equal(f.counts.mint,1);assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,1);
 assert.equal(fs.existsSync(data),false,'Actual transient bare Git/runtime cleanup');
}finally{f.cleanup();}});
test('actual wrong bare Git HEAD refuses before mint',async()=>{const f=fixture();try{
 assert.ok(modern,'Immutable a443 has no isolated trusted consumer');const options=f.options();
 options.effects.prepare=(b,ws,root)=>{const r=modern.prepare(b,ws,root,a=>{
  if(a.includes('show') && a.at(-1).startsWith(fixtureConfig.publicationRuntime.sha+':')) return fs.readFileSync(path.join(workspace,a.at(-1).split(':')[1]));
  return execFileSync('git',a.map(x=>x==='https://github.com/open-hax/proxx.git'?workspace:x===fixtureConfig.publicationRuntime.sha?head:x),{maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});});
  fs.writeFileSync(path.join(r.directory,'HEAD'),base+'\n');return r;};
 await assert.rejects(modern.run(options));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
}finally{f.cleanup();}});
for(const mode of ['duplicate','traversal','symlink','missing','invalid-provenance-UTF8','malformed-JSON','over-expanded-budget'])
test(`actual ZIP ${mode} refuses before mint`,async()=>{const f=fixture();try{
 const program=`import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n r=open(sys.argv[2],'rb').read();p=open(sys.argv[3],'rb').read();mode=sys.argv[4]\n if mode=='over-expanded-budget':r+=b' '*2097152\n if mode=='malformed-JSON':r=b'{'\n if mode=='invalid-provenance-UTF8':p=b'\\xff'\n if mode=='symlink':\n  i=zipfile.ZipInfo('kimi-review.json');i.create_system=3;i.external_attr=0o120777<<16;z.writestr(i,r)\n else:z.writestr('kimi-review.json',r)\n if mode!='missing':z.writestr('kimi-provenance.json',p)\n if mode=='duplicate':z.writestr('kimi-review.json',r)\n if mode=='traversal':z.writestr('../data',b'never execute')`;
 const z=path.join(f.dir,'malformed.zip');execFileSync('python3',['-c',program,z,path.join(f.dir,'zip-review'),path.join(f.dir,'zip-provenance'),mode],{stdio:['ignore','pipe','pipe']});
 f.zip=fs.readFileSync(z);f.artifacts[0].digest='sha256:'+sha(f.zip);f.artifacts[0].size_in_bytes=f.zip.length;
 await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
}finally{f.cleanup();}});

if (modern) {
 test('production null authority refuses before native reads, key access, mint or downloads', async () => {
  const f=fixture();try {const options=f.options();let effects=0;
   options.effects.api=async()=>{effects++;throw Error('Trap native read');};
   options.effects.withToken=async()=>{effects++;throw Error('Trap mint');};
   Object.defineProperty(options.env,'PROXX_KIMI_APP_PRIVATE_KEY',{get(){effects++;throw Error('Trap key');}});
   await assert.rejects(require('./kimi-publisher.cjs').run(options));assert.equal(effects,0);assert.equal(f.counts.downloads,0);
  }finally{f.cleanup();}
 });
 test('production registry refuses owned Kimi and preserves both existing exact actors', () => {
  const registry=require('./opencode-app-auth.cjs');assert.throws(()=>registry.publisherPrincipal('proxx-owned-kimi'),/unconfigured/);
  assert.equal(registry.publisherPrincipal('opencode-agent').id,219766164);assert.equal(registry.publisherPrincipal('github-actions').id,41898282);
  assert.throws(()=>registry.publisherPrincipal('eta-mu-ai'));
 });
 for(const path of ['.github/scripts/proxx-kimi-app-auth.cjs','.github/scripts/kimi_publisher_law.cljc',
   '.github/scripts/kimi-publication-config.cjs','.github/scripts/kimi-publication-authority.cjs','.github/assessment-tools/package-lock.json'])
 test(`credential executable/source mutation ${path} refuses before mint`,async()=>{const f=fixture();try{
  const api=f.api;f.api=async endpoint=>{const v=await api(endpoint);if(endpoint.includes('/contents/'+path+'?')){
   const bytes=Buffer.from(v.content,'base64');return source(Buffer.concat([bytes,Buffer.from('changed')]),path);}return v;};
  await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
 }finally{f.cleanup();}});
}

if(modern) for(const file of ['kimi-review.cjs','opencode-app-auth.cjs','kimi-publication-authority.cjs'])
 test(`publication scratch mutation ${file} refuses before mint`,async()=>{const f=fixture();try{
  fs.appendFileSync(path.join(f.publication,file),'\nchanged');await assert.rejects(run(f));assert.equal(f.counts.mint,0);assert.equal(f.counts.post,0);
 }finally{f.cleanup();}});

// Publisher cost/freshness regressions: synthetic local external effects only.
/**
 * Add synthetic findings and read, write, webhook and diff counters to the publisher fixture for cost and freshness regressions.
 */
function costFixture(count = 0) {
  const f = fixture();
  const file = f.review.coveredFiles[0];
  f.review.comments = Array.from({ length: count }, (_, i) => ({ path: file, line: 1, body: `Synthetic local finding ${i}; no native assessment.` }));
  f.provenance.reviewBlobSha256 = sha(Buffer.from(JSON.stringify(f.review))); f.refresh();
  f.env.DISCORD_REVIEW_WEBHOOK_URL = 'https://synthetic.invalid/owned-fixture';
  f.cost = { appReads: 0, updates: 0, discord: 0, diff: 0, beforeUpdateReads: [] };
  const diff = f.helper.diffCoverage; f.helper.diffCoverage = (...args) => { f.cost.diff++; return diff(...args); };
  const get = f.app.rest.pulls.get; f.app.rest.pulls.get = async args => { f.cost.appReads++; return get(args); };
  const readback = f.app.rest.pulls.getReview;
  f.app.rest.pulls.getReview = async args => { f.cost.appReads++; f.nativeReads = (f.nativeReads || 0) + 1;
    if (f.mutateOnRead && f.nativeReads === 1) f.mutateOnRead(); return readback(args); };
  const update = f.app.rest.pulls.updateReview;
  f.app.rest.pulls.updateReview = async args => { f.cost.updates++; f.cost.beforeUpdateReads.push(f.apiTrace.length); return update(args); };
  const listFiles = f.app.rest.pulls.listFiles, listReviews = f.app.rest.pulls.listReviews, listComments = f.app.rest.pulls.listCommentsForReview;
  f.app.paginate = async method => {
    f.cost.appReads++;
    if (method === listFiles) return [{ filename: file, patch: '@@ -0,0 +1 @@\n+synthetic' }];
    if (method === listReviews) return clone(f.native);
    if (method === listComments) return Array.from({ length: count }, (_, i) => ({ id: 8000 + i, pull_request_review_id: 7004,
      commit_id: head, path: file, line: 1, body: f.review.comments[i].body,
      html_url: `https://github.com/open-hax/proxx/pull/452#discussion_r${8000+i}`, user: clone(fixtureAuthority.principal) }));
    throw Error('Unexpected synthetic App read');
  };
  const options = f.options;
  f.options = () => { const o = options(); const lifetime = o.effects.withToken;
    // Exercise the authentic auth callback's preMint position without any key/sign/HTTP effects.
    o.effects.withToken = async (opts, use) => { await opts.preMint(); return lifetime(opts, use); };
    return o; };
  return f;
}
/**
 * Run a publisher fixture with a synthetic webhook fetch and restore the previous global fetch in finally.
 */
async function runCost(f) {
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://synthetic.invalid/owned-fixture'); assert.equal(options.method, 'POST');
    f.cost.discord++; return { ok: true, status: 204 };
  };
  try { return await run(f); } finally { globalThis.fetch = prior; }
}
for (const n of [0, 1, 10, 100]) test(`fresh write cost bounded with ${n} inline comments`, async () => {
  const f = costFixture(n); try {
    await runCost(f);
    assert.equal(f.counts.mint, 1); assert.equal(f.counts.revoke, 1); assert.equal(f.counts.post, 1);
    assert.equal(f.cost.updates, n); assert.equal(f.cost.discord, n);
    assert.equal(f.cost.appReads, 5 + 3*n, 'Native App readbacks and pagination are preserved');
    if (globalThis.ownedCostMetrics) globalThis.ownedCostMetrics.push({ n, githubReads: f.apiTrace.length, archiveReads: f.counts.downloads,
      appReads: f.cost.appReads, createWrites: f.counts.post, updateWrites: f.cost.updates, discord: f.cost.discord, adapterDiffCalls: f.cost.diff });
    assert.equal(f.apiTrace.filter(x=>x.includes('/contents/')).length, 42, 'Exactly three full14-source collections');
    assert.equal(f.apiTrace.filter(x=>x.includes('/jobs?')).length, n+5, 'Terminal job records stay fresh at every admission boundary');
    assert.equal(f.apiTrace.length, 75 + 9*(n+2), 'Three25-read full collections plus9-read preMint/actual-write checks');
    assert.ok(f.apiTrace.length + f.counts.downloads < 1000, 'One-page authority inventories fit the stated per-run regression budget');
    assert.equal(f.cost.diff, 3, 'Initial/full pre-mint/post-revocation diff computation only');
    const body = f.native[0].body;
    assert.equal((body.match(/\n<!-- kimi-discord-delivered:v1:/g)||[]).length, n);

  } finally { f.cleanup(); }
});
for (const [name, change] of [
 ['head', f=>f.pr.head.sha='a'.repeat(40)], ['base', f=>f.pr.base.sha='a'.repeat(40)],
 ['closed', f=>f.pr.state='closed'], ['draft', f=>f.pr.draft=true], ['PR association', f=>f.producer.pull_requests[0].number=453],
 ['foreign PR repo', f=>f.pr.head.repo.id=1], ['producer attempt', f=>f.producer.run_attempt++],
 ['producer conclusion', f=>f.producer.conclusion='failure'], ['producer state', f=>f.producer.status='in_progress'],
 ['producer head', f=>f.producer.head_sha='a'.repeat(40)], ['producer repo', f=>f.producer.repository.id=1],
 ['producer workflow', f=>f.workflow.state='disabled_manually'], ['producer workflow ID', f=>f.producer.workflow_id=1],
 ['consumer attempt', f=>f.consumer.run_attempt++], ['consumer cancellation', f=>f.consumer.status='completed'],
 ['consumer source', f=>f.consumer.head_sha='a'.repeat(40)], ['consumer repo', f=>f.consumer.head_repository.id=1],
 ['consumer workflow', f=>f.consumerWorkflow.state='disabled_manually'], ['consumer workflow ID', f=>f.consumer.workflow_id=1],
 ['default ref', f=>f.defaultRef='a'.repeat(40)], ['default branch', f=>f.repo.default_branch='staging'],
 ['repository identity', f=>f.repo.id=1], ['source HEAD', f=>f.checkedOutSha='a'.repeat(40)],
 ['merge ref', f=>f.pr.merge_commit_sha='a'.repeat(40)], ['artifact expiry', f=>f.artifacts[0].expired=true],
 ['artifact deletion', f=>f.artifacts=[]], ['artifact ambiguity', f=>f.artifacts.push({...f.artifacts[0],id:402})],
 ['archive digest', f=>f.artifacts[0].digest='sha256:'+'0'.repeat(64)],
 ['retained archive bytes', f=>f.zip[0]^=1],
 ['producer job status', f=>f.jobs[0].conclusion='failure'],
 ['producer job step', f=>f.jobs[0].steps[2].conclusion='skipped'],
]) test(`fresh authority mutation before receipt write refuses ${name}`, async () => {
 const f=costFixture(1);try {f.mutateOnRead=()=>change(f);await assert.rejects(runCost(f));
  assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
  const c=JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK));assert.equal(c.id,7004);assert.equal(c.stage,'published-not-reconciled');
 }finally{f.cleanup();}
});

for (const file of ['kimi-review.cjs', 'opencode-app-auth.cjs', 'kimi-publication-authority.cjs'])
test(`publication scratch mutation before receipt write refuses ${file}`, async () => {
 const f=costFixture(1);try {
  f.mutateOnRead=()=>fs.appendFileSync(path.join(f.publication,file),'\nchanged');
  await assert.rejects(runCost(f));assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
 }finally{f.cleanup();}
});
for (const file of ['kimi-review.cjs', 'opencode-app-auth.cjs'])
test(`pinned281 scratch mutation before receipt write refuses ${file}`, async () => {
 const f=costFixture(1);try {
  f.mutateOnRead=()=>fs.appendFileSync(path.join(f.trusted,file),'\nchanged');
  await assert.rejects(runCost(f));assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
 }finally{f.cleanup();}
});
test('full admission after revocation rechecks terminal job evidence', async () => {
 const f=costFixture(0);try {
  const options=f.options;
  f.options=()=>{const o=options(), lifetime=o.effects.withToken;
   o.effects.withToken=async(...args)=>{const result=await lifetime(...args);f.jobs[0].conclusion='failure';return result;};return o;};
  await assert.rejects(runCost(f));assert.equal(f.counts.post,1);assert.equal(f.counts.revoke,1);
  assert.equal(JSON.parse(fs.readFileSync(f.env.KIMI_PUBLICATION_READBACK)).stage,'published-not-reconciled');
 }finally{f.cleanup();}
});
test('fresh receipt authority collection rejects a failed authoritative GET', async () => {
 const f=costFixture(1);try {
  f.mutateOnRead=()=>{f.failAPI=true;};await assert.rejects(runCost(f));
  assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
 }finally{f.cleanup();}
});

for (const file of [
 '.github/workflows/opencode-code-review.yml','.github/workflows/opencode-kimi-publish.yml',
 '.github/scripts/kimi-publisher.cjs','.github/scripts/kimi_publisher_law.cljc',
 '.github/scripts/kimi_publisher_bridge.cljs','.github/scripts/proxx-kimi-app-auth.cjs',
 '.github/scripts/opencode-app-auth.cjs','.github/scripts/kimi-review.cjs',
 '.github/scripts/kimi-publication-authority.cjs','.github/scripts/kimi-publication-config.cjs',
 '.github/assessment-tools/package.json','.github/assessment-tools/package-lock.json',
]) test(`retained default source bytes before receipt write refuse ${file}`, async () => {
 const f=costFixture(1), target=path.join(workspace,file), original=fs.readFileSync(target);
 try {
  f.mutateOnRead=()=>fs.appendFileSync(target,'\nchanged');await assert.rejects(runCost(f));
  assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
 }finally{fs.writeFileSync(target,original);f.cleanup();}
});
test('retained parsed submission bytes before receipt write refuse mutation', async () => {
 const f=costFixture(1);try {
  f.mutateOnRead=()=>{const root=fs.readdirSync(f.dir).find(x=>x.startsWith('kimi-trusted-publish-'));
   const target=path.join(f.dir,root,'kimi-review.json');fs.chmodSync(target,0o600);fs.appendFileSync(target,'\nchanged');};
  await assert.rejects(runCost(f));assert.equal(f.counts.post,1);assert.equal(f.cost.updates,0);assert.equal(f.counts.revoke,1);
 }finally{f.cleanup();}
});
