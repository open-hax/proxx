// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Effects only. Admission decisions are evaluated by default-source Clojure law.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
/**
 * Hash exact source or archive bytes for the publication binding; do not normalize them.
 */
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
/**
 * Decode inert source or submission bytes as strict UTF-8, refusing malformed input.
 */
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const LIMIT = 2 * 1024 * 1024;
const RUNTIME = '2810f4515424a146fe37390fb0baf532cca31236';
const RUNTIME_HASH = '0fa9d7838df3f0718d971beb972a48d2bf73fce6d90f09411a656e57ce3960d7';
const AUTH_HASH = 'fd4d5630c462f0f202ac20e39ec1433fba4dfa13e12a6f6ffd5c0ec035d2a7e1';
const PRODUCER = '.github/workflows/opencode-code-review.yml';
const PUBLISHER = '.github/workflows/opencode-kimi-publish.yml';
const config = require('./kimi-publication-config.cjs');
const { withOwnedKimiToken } = require('./proxx-kimi-app-auth.cjs');
const SOURCE_PATHS = [PUBLISHER, '.github/scripts/kimi-publisher.cjs',
  '.github/scripts/kimi_publisher_law.cljc', '.github/scripts/kimi_publisher_bridge.cljs',
  '.github/scripts/proxx-kimi-app-auth.cjs', '.github/scripts/opencode-app-auth.cjs',
  '.github/scripts/kimi-review.cjs', '.github/scripts/kimi-publication-authority.cjs',
  '.github/scripts/kimi-publication-config.cjs', '.github/assessment-tools/package.json',
  '.github/assessment-tools/package-lock.json'];
/**
 * Reject an unestablished native, source or artifact binding before credential use.
 */
function refuse() { throw Error('Trusted Kimi publication binding refused'); }
/**
 * Collect the native workflow event and consumer identity fields required by the pure trigger law.
 */
function nativeInput(context, env) {
  return { 'event-name': env.GITHUB_EVENT_NAME, action: context.payload.action,
    'event-repository': context.payload.repository, 'event-run': context.payload.workflow_run,
    'run-id': Number(env.GITHUB_RUN_ID), 'run-attempt': Number(env.GITHUB_RUN_ATTEMPT),
    'source-sha': env.GITHUB_SHA, 'workflow-sha': env.KIMI_PUBLISHER_WORKFLOW_SHA,
    'workflow-ref': env.KIMI_PUBLISHER_WORKFLOW_REF, authorization: env.KIMI_PUBLISHER_AUTHORIZATION };
}
/**
 * Load the publisher bridge from the trusted workspace and return its pure admission operations.
 */
async function loadLaw(workspace) {
  const nbb = await import(pathToFileURL(path.join(workspace, '.github/assessment-tools/node_modules/nbb/index.mjs')));
  nbb.addClassPath(path.join(workspace, '.github/scripts'));
  return nbb.loadFile(path.join(workspace, '.github/scripts/kimi_publisher_bridge.cljs'));
}
/**
 * Verify a bounded native Git file response, canonical Base64, blob identity and strict UTF-8 before returning its bytes.
 */
function sourceBytes(value, file) {
  const encoded = String(value.content || '').replace(/\s/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  const blob = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  if (value.type !== 'file' || value.path !== file || value.encoding !== 'base64' ||
      bytes.length > 1024 * 1024 || bytes.toString('base64') !== encoded || blob !== value.sha) refuse();
  decode(bytes); return bytes;
}
/**
 * Collect a bounded native jobs or artifacts inventory, rejecting duplicate IDs and incomplete total counts.
 */
async function pages(api, endpoint, key) {
  let all = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const part = value[key];
    if (!Array.isArray(part) || part.length > 100 || !Number.isSafeInteger(value.total_count) || value.total_count < 0) refuse();
    all.push(...part);
    if (new Set(all.map(v => v.id)).size !== all.length) refuse();
    if (part.length < 100) { if (all.length !== value.total_count) refuse(); return all; }
  }
  refuse();
}
/**
 * Gather current producer, consumer, PR, repository, jobs, artifacts and immutable source evidence for native admission.
 */
async function collect({ api, input, workspace, archiveSha256, sourceHead }) {
  const root = 'repos/open-hax/proxx';
  const repo = await api(root);
  const producer = await api(`${root}/actions/runs/${input['event-run'].id}`);
  const consumer = await api(`${root}/actions/runs/${input['run-id']}`);
  const association = producer.pull_requests?.length === 1 ? producer.pull_requests[0] : null;
  if (!Number.isSafeInteger(association?.number) || association.number < 1) refuse();
  const pr = await api(`${root}/pulls/${association.number}`);
  // The current native PR supplies the merge source, never an artifact-chosen SHA.
  if (!/^[0-9a-f]{40}$/.test(pr.merge_commit_sha || '') || !/^[0-9a-f]{40}$/.test(pr.head?.sha || '')) refuse();
  const producerWorkflow = await api(`${root}/actions/workflows/285819940`);
  const consumerWorkflow = await api(`${root}/actions/workflows/${encodeURIComponent(PUBLISHER)}`);
  const defaultRef = await api(`${root}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  const jobs = await pages(api, `${root}/actions/runs/${producer.id}/attempts/${producer.run_attempt}/jobs`, 'jobs');
  const artifacts = await pages(api, `${root}/actions/runs/${producer.id}/artifacts`, 'artifacts');
  const commit = await api(`${root}/commits/${pr.merge_commit_sha}`);
  const getSource = async (ref, file) => sourceBytes(await api(`${root}/contents/${file}?ref=${ref}`), file);
  const mergeSource = await getSource(pr.merge_commit_sha, PRODUCER);
  const headSource = await getSource(pr.head.sha, PRODUCER);
  const consumerSource = await getSource(input['source-sha'], PUBLISHER);
  const credentialManifest = [];
  for (const file of SOURCE_PATHS) credentialManifest.push({ path: file,
    trusted: hash(fs.readFileSync(path.join(workspace, file))), native: hash(await getSource(input['source-sha'], file)) });
  const comparison = await api(`${root}/compare/${config.publicationRuntime.sha}...${input['source-sha']}`);
  const runtimeAncestor = ['ahead', 'identical'].includes(comparison.status) &&
    comparison.merge_base_commit?.sha === config.publicationRuntime.sha;
  const expected = `kimi-native-${producer.id}-${association.number}-${producer.head_sha}-${producer.run_attempt}`;
  const candidates = artifacts.filter(v => v.name === expected);
  // A deterministic native tuple replaces unavailable cross-workflow job outputs.
  // Missing/ambiguous names never fall back to downloading every artifact.
  if (candidates.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(candidates[0].digest || '')) refuse();
  return { input, repo, 'default-ref': defaultRef, producer, 'producer-workflow': producerWorkflow,
    consumer, 'consumer-workflow': consumerWorkflow, pr, jobs, artifacts,
    sources: { 'producer-commit': commit, 'publisher-commit': sourceHead ? sourceHead() :
      execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(),
      'producer-head-digest': hash(headSource), 'producer-merge-digest': hash(mergeSource),
      'trusted-producer-digest': hash(fs.readFileSync(path.join(workspace, PRODUCER))),
      'publisher-native-digest': hash(consumerSource),
      'trusted-publisher-digest': hash(fs.readFileSync(path.join(workspace, PUBLISHER))),
      'credential-source-manifest': credentialManifest, 'publication-runtime-ancestor': runtimeAncestor,
      'archive-sha256': archiveSha256 || candidates[0].digest.slice(7) } };
}
// Refresh every mutable native authority through the same CLJC native law.
// Only commit-addressed Git/source proofs are reused. Job records and artifact
// inventory remain fresh (steps/status, expiry/deletion/ambiguity).
/**
 * Refresh mutable native authority immediately before a write while retaining the admitted immutable source bindings.
 */
async function collectWriteState({ api, input, workspace, admitted, archiveSha256, sourceHead }) {
  const root = 'repos/open-hax/proxx';
  const repo = await api(root);
  const producer = await api(`${root}/actions/runs/${input['event-run'].id}`);
  const consumer = await api(`${root}/actions/runs/${input['run-id']}`);
  const pr = await api(`${root}/pulls/${admitted.pr.number}`);
  const producerWorkflow = await api(`${root}/actions/workflows/285819940`);
  const consumerWorkflow = await api(`${root}/actions/workflows/${encodeURIComponent(PUBLISHER)}`);
  const defaultRef = await api(`${root}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  const jobs = await pages(api, `${root}/actions/runs/${producer.id}/attempts/${producer.run_attempt}/jobs`, 'jobs');
  const artifacts = await pages(api, `${root}/actions/runs/${producer.id}/artifacts`, 'artifacts');
  return { ...admitted, repo, producer, consumer, pr, jobs, artifacts,
    'producer-workflow': producerWorkflow, 'consumer-workflow': consumerWorkflow, 'default-ref': defaultRef,
    sources: { ...admitted.sources, 'archive-sha256': archiveSha256,
      'publisher-commit': sourceHead ? sourceHead() :
        execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(),
      'trusted-producer-digest': hash(fs.readFileSync(path.join(workspace, PRODUCER))),
      'trusted-publisher-digest': hash(fs.readFileSync(path.join(workspace, PUBLISHER))),
      'credential-source-manifest': admitted.sources['credential-source-manifest'].map(row => ({ ...row,
        trusted: hash(fs.readFileSync(path.join(workspace, row.path))) })) } };
}
/**
 * Read only the two bounded submission JSON members from an inert ZIP after standard-library path, type and CRC validation.
 */
function unpack(bytes, directory) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LIMIT) refuse();
  const file = path.join(directory, 'submission.zip'); fs.writeFileSync(file, bytes, { mode: 0o600 });
  // Delegate ZIP/CRC semantics to the standard library; never evaluate a member.
  const code = `import zipfile,stat,json,base64,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n a=z.infolist()\n assert sorted(i.filename for i in a)==['kimi-provenance.json','kimi-review.json']\n assert sum(i.file_size for i in a)<=2097152\n assert all(not i.is_dir() and stat.S_IFMT(i.external_attr>>16) in (0,stat.S_IFREG) and not (i.flag_bits&1) for i in a)\n print(json.dumps({i.filename:base64.b64encode(z.read(i)).decode('ascii') for i in a}))`;
  const value = JSON.parse(decode(execFileSync('python3', ['-c', code, file],
    { timeout: 5000, maxBuffer: 3 * LIMIT, stdio: ['ignore', 'pipe', 'pipe'] })));
  const reviewBytes = Buffer.from(value['kimi-review.json'], 'base64');
  const provenanceBytes = Buffer.from(value['kimi-provenance.json'], 'base64');
  const review = JSON.parse(decode(reviewBytes)), provenance = JSON.parse(decode(provenanceBytes));
  return { review, provenance, reviewBytes, provenanceBytes };
}
/**
 * Prepare bare candidate Git data and hash-verified trusted helpers without checking out or executing candidate source.
 */
function prepare(binding, _workspace, root, gitEffect) {
  const directory = path.join(root, 'git-data'), trusted = path.join(root, 'trusted-runtime');
  fs.mkdirSync(directory); fs.mkdirSync(trusted);
  const git = gitEffect || (args => execFileSync('git', args,
    { timeout: 120000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  git(['init', '--bare', '--quiet', directory]);
  git(['-C', directory, 'config', 'core.hooksPath', '/dev/null']);
  git(['-C', directory, 'fetch', '--no-tags', 'https://github.com/open-hax/proxx.git', binding.head, binding.base, RUNTIME, config.publicationRuntime.sha]);
  // The helper only needs actual HEAD and Git diff data. No candidate checkout,
  // smudge filters, hooks, package files or executable directories are needed.
  fs.writeFileSync(path.join(directory, 'HEAD'), `${binding.head}\n`);
  git(['-C', directory, 'merge-base', '--is-ancestor', RUNTIME, binding.base]);
  for (const name of ['kimi-review.cjs', 'opencode-app-auth.cjs']) {
    const bytes = git(['-C', directory, 'show', `${RUNTIME}:.github/scripts/${name}`]);
    if (hash(bytes) !== (name === 'kimi-review.cjs' ? RUNTIME_HASH : AUTH_HASH)) refuse();
    fs.writeFileSync(path.join(trusted, name), bytes, { mode: 0o400 });
  }
  const publication = path.join(root, 'publication-runtime'); fs.mkdirSync(publication);
  for (const [name, digest] of [['kimi-review.cjs', 'reviewSHA256'], ['opencode-app-auth.cjs', 'authSHA256'],
    ['kimi-publication-authority.cjs', 'authoritySHA256']]) {
    const bytes = git(['-C', directory, 'show', `${config.publicationRuntime.sha}:.github/scripts/${name}`]);
    if (hash(bytes) !== config.publicationRuntime[digest]) refuse();
    if (!bytes.equals(fs.readFileSync(path.join(_workspace, '.github/scripts', name)))) refuse();
    fs.writeFileSync(path.join(publication, name), bytes, { mode: 0o400 });
  }
  return { directory, trusted, publication, helper: require(path.join(trusted, 'kimi-review.cjs')),
    publicationHelper: require(path.join(publication, 'kimi-review.cjs')), ancestor: true };
}
/**
 * Persist native review readback atomically, retaining its ID if later publication or reconciliation fails.
 */
function checkpoint(file) {
  if (!file || !path.isAbsolute(file)) refuse();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const save = value => {
    const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.partial`;
    try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  };
  let state = fs.existsSync(file) ? JSON.parse(decode(fs.readFileSync(file))) : { stage: 'not-established' };
  if (!state || Array.isArray(state) || typeof state !== 'object') refuse();
  // Writability preflight preserves a known native ID if a retry later refuses.
  save(state);
  return { record(native) {
    if (!Number.isSafeInteger(native?.id) || native.id < 1) return;
    state = { stage: 'published-not-reconciled', id: native.id, url: native.html_url || null,
      head: native.commit_id || null, bodySHA256: typeof native.body === 'string' ? hash(Buffer.from(native.body)) : null,
      user: native.user ? { login: native.user.login, id: native.user.id, type: native.user.type } : null };
    save(state);
  }, complete(binding) { state = { ...state, stage: 'complete',
    // These describe this successful operation, never relabel a deduplicated
    // native review's original producer/consumer provenance or approval.
    operationProducerRunID: binding['producer-id'], operationProducerAttempt: binding['producer-attempt'],
    operationConsumerRunID: binding['consumer-id'], operationConsumerAttempt: binding['consumer-attempt'] }; save(state); } };
}
/**
 * Admit exact native source and full-diff evidence before minting, guard each write, await token cleanup, and reconcile publication.
 */
async function run({ github, core, context, env = process.env, effects = {} }) {
  const workspace = env.GITHUB_WORKSPACE;
  const law = await (effects.loadLaw || loadLaw)(workspace);
  law.authority(config); // Static actual identity and reviewed successor pins; null refuses before effects/key use.
  const input = nativeInput(context, env); law.trigger(input);
  const receipt = checkpoint(env.KIMI_PUBLICATION_READBACK);
  const api = effects.api || (async endpoint => (await github.request(`GET /${endpoint}`)).data);
  const root = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'kimi-trusted-publish-'));
  const oldCwd = process.cwd();
  try {
    const first = await collect({ api, input, workspace, sourceHead: effects.sourceHead });
    const binding = law.native(first);
    const selected = first.artifacts.find(v => v.id === binding['artifact-id']);
    const archive = effects.download ? await effects.download(selected.id) :
      Buffer.from((await github.request('GET /repos/open-hax/proxx/actions/artifacts/{artifact_id}/{archive_format}',
        { artifact_id: selected.id, archive_format: 'zip' })).data);
    if (archive.length !== selected.size_in_bytes || `sha256:${hash(archive)}` !== selected.digest) refuse();
    const parsed = unpack(archive, root);
    const runtime = (effects.prepare || prepare)(binding, workspace, root);
    process.chdir(runtime.directory);
    const file = path.join(root, 'kimi-review.json'); fs.writeFileSync(file, parsed.reviewBytes, { mode: 0o400 });
    const fullCoverage = runtime.helper.diffCoverage(binding.base, binding.head);
    const validate = (recheckCoverage = true) => {
      runtime.helper.assertHead(binding.head, execFileSync('git', ['rev-parse', 'HEAD'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
      // Bare Git objects are content-addressed; unchanged HEAD/base and exact
      // retained artifact/source bytes permit reuse between the two full guards.
      const fresh = recheckCoverage ? runtime.helper.diffCoverage(binding.base, binding.head) : fullCoverage;
      if (!require('node:util').isDeepStrictEqual(fresh, fullCoverage)) refuse();
      for (const [name, digest] of [['kimi-review.cjs', 'reviewSHA256'], ['opencode-app-auth.cjs', 'authSHA256'],
        ['kimi-publication-authority.cjs', 'authoritySHA256']]) {
        const bytes = fs.readFileSync(path.join(runtime.publication, name));
        if (hash(bytes) !== config.publicationRuntime[digest] ||
            !bytes.equals(fs.readFileSync(path.join(workspace, '.github/scripts', name)))) refuse();
      }
      const runtimeBytes = fs.readFileSync(path.join(runtime.trusted, 'kimi-review.cjs'));
      const authBytes = fs.readFileSync(path.join(runtime.trusted, 'opencode-app-auth.cjs'));
      if (!fs.readFileSync(file).equals(parsed.reviewBytes)) refuse();
      law.artifact({ binding, ...parsed, runtime: hash(runtimeBytes), auth: hash(authBytes),
        'review-digest': hash(parsed.reviewBytes), coverage: fresh, 'ancestor?': runtime.ancestor,
        request: runtime.helper.structuredRequest('', binding.head, fresh) });
      runtime.helper.assertReviewablePaths(fresh.coveredFiles);
      const { executionControl, ...review } = parsed.review;
      runtime.helper.validateReview(review);
    };
    let admitted = first;
    const fullGuard = async () => {
      validate();
      const observation = await collect({ api, input, workspace, archiveSha256: hash(archive), sourceHead: effects.sourceHead });
      const fresh = law.native(observation);
      if (!require('node:util').isDeepStrictEqual(fresh, binding)) refuse();
      admitted = observation;
    };
    const writeGuard = async () => {
      validate(false);
      const fresh = law.native(await collectWriteState({ api, input, workspace, admitted, archiveSha256: hash(archive), sourceHead: effects.sourceHead }));
      if (!require('node:util').isDeepStrictEqual(fresh, binding)) refuse();
    };
    await fullGuard(); // All authoritative native/source/Git/artifact guards precede mint.
    const footer = `\n\nNative execution provenance (runtime observations, not provider attestation or reviewer quorum):\n\`\`\`json\n${JSON.stringify(law.body(binding, parsed.provenance), null, 2)}\n\`\`\``;
    const mint = effects.withToken || withOwnedKimiToken;
    await mint({ core, law, preMint: writeGuard, readKey: () => env.PROXX_KIMI_APP_PRIVATE_KEY }, async token => {
      const app = effects.appClient ? effects.appClient(token) : new github.constructor({ auth: token });
      const pulls = { ...app.rest.pulls };
      for (const method of ['createReview', 'updateReview']) {
        const original = pulls[method].bind(app.rest.pulls);
        pulls[method] = async args => { await writeGuard(); const result = await original(args);
          receipt.record(result.data); return result; };
      }
      const guarded = { rest: { ...app.rest, pulls }, paginate: app.paginate.bind(app) };
      await runtime.publicationHelper.publish({ github: guarded,
        context: { repo: { owner: 'open-hax', repo: 'proxx' }, payload: { pull_request: first.pr } }, file,
        publisher: 'proxx-owned-kimi', publicationFooter: footer, webhookUrl: env.DISCORD_REVIEW_WEBHOOK_URL,
        fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20_000) }) });
    });
    // Completion follows the dedicated auth callback's awaited finally/revocation.
    await fullGuard();
    receipt.complete(binding);
    return binding;
  } catch { throw Error('Trusted Kimi publisher failed; retained native checkpoint may require reconciliation'); }
  finally { process.chdir(oldCwd); fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { run, loadLaw, collect, unpack, checkpoint, prepare };
