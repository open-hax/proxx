# Read-only model catalog watcher

Proxx owns endpoint-scoped model catalog evidence. This watcher records literal
model availability and visible alias/capability drift; it does not route requests,
invoke models, select agents, establish quota/entitlement, or evaluate review input.
Reviewer input/manifest semantics belong upstream to Muse/eta-mu and are absent
from this implementation. Historical diagnostic and receipt records are retained.

## Responsibilities

- `src/proxx/policy/model_availability.cljc` is pure portable catalog law:
  `assess-model`, `capability-fingerprint`, and `advance-baseline`.
- `src/proxx/policy/catalog_watch.cljs` is the NBB outer adapter. It reuses
  Proxx's existing catalog ID decoder. The older evidence loader collapses fetch
  failures to empty lists, so its transport cannot preserve the evidence this
  detector needs. No existing runtime export or routing path changes.
- `scripts/watch_model_catalogs.cljs` performs one read-only poll and exits.
  Repeat it at use time; use one writer per baseline file. No daemon, schedule,
  deployment, agent binding, OpenCode configuration edit, or paid fallback.

An observation carries provider ID, endpoint, opaque nonsecret account/profile
scope, source kind, collection provenance, timestamp, status, completeness, and
selected public metadata.
Change the scope when changing accounts/plans. Never use a key as scope identity.

`listed` means fresh authoritative catalog presence. A first complete absence is
`unlisted`; `delisted` requires a previous actual authoritative listing and a
newer fresh complete successful catalog in the same scope. Transport/auth/quota
failures, stale/future observations, partial pages, missing registrations and
invalid data cannot prove removal. Failed observations preserve the last good
baseline. A catalog listing does not establish successful model execution.

Capability fingerprints use canonical EDN, independent of map/set ordering.
Missing metadata, nil and false remain distinct. Observed target changes are
compared separately. Only selected public context/token limits, name/owner/version,
reasoning controls, supported tools and modalities are retained. Hidden provider
changes with identical metadata remain unobservable. Zen/Go `created` equals
response time and is excluded from capability identity.
An absent target remains unknown: the listing ID is never substituted for target
metadata. Only two explicitly observed different targets establish alias change.

## Run

From the repository root, with the named credentials already bound in the process
environment:

```bash
nbb -cp src scripts/watch_model_catalogs.cljs resources/model-catalog-watch.example.edn
```

The example uses `OPENCODE_ZEN_API_KEY`, `OPENCODE_GO_API_KEY`, `KIMI_API_KEY`
and `KIMI_CN_API_KEY`. Config contains environment variable names only; the CLI
has no key/header argument or auth-store reader. Exact official catalog URLs are
allowlisted and redirects rejected. `--allow-loopback` permits only the narrow
local fixture endpoint used by tests, not another production provider.

Config injects `:max-age-ms` and `:timeout-ms`. `--now-ms MS` injects the test clock;
`--observations FILE` replays public `{:snapshots [...]}` data without a network
call. Reports and snapshots distinguish supplied assertions from authenticated
GET collection. The invocation assigns provenance, overriding claims in supplied
files. Replay is stateless: it does not read, compare against, create, or overwrite
the live baseline, so it cannot establish removal from authenticated history.
Successful commands append timestamp/UUID reports and atomically advance a
last-good baseline only for complete fresh authenticated authoritative observations. Invalid
clock/scopes, duplicate observations and reflected credentials reject input.
HTTP error bodies, headers, keys and arbitrary response fields are not persisted.
Untagged legacy snapshots cannot establish authenticated history. A later actual
successful GET establishes a new tagged baseline rather than promoting legacy
data. `:baseline-updated?` explicitly reports whether state advanced.

Exit 0 means a report was captured, including explicit `unknown` results. Exit 2
means a command/input/storage error. The mutable baseline is an observation
projection, not ledger history or routing authority; reports preserve earlier
removal events after baseline updates.

Optional `:registration-file` accepts independent public runtime metadata:

```clojure
{:observed-at-ms 1791065503957
 :models {"opencode" #{"mimo-v2.6-flash-free"}
          "kimi-code-plan-global" #{"kimi-for-coding"}}}
```

Registration freshness uses the injected TTL. Missing/stale registration stays
unknown independently of catalog presence. No execution assurance is inferred.

## Kimi endpoints and credential scopes

The original example reversed the regional provider IDs. The corrected example
matches [Kimi's official base URLs](https://www.kimi.com/code/docs/en/kimi-code/models.html)
and the actual OpenCode 1.18.30 listing:

| Native provider ID | Region / catalog | Watcher env | Previously tested profile |
|---|---|---|---|
| `kimi-code-plan-cn` | China: `https://api.kimi.com/coding/v1/models` | `KIMI_CN_API_KEY` | `local-opencode-auth:kimi-for-coding` |
| `kimi-code-plan-global` | Overseas: `https://api.kimi.ai/coding/v1/models` | `KIMI_API_KEY` | `local-opencode-auth:kimi-for-code` |

Primary runtime definitions at models.dev commit
`75c34eea924c565b39ea426730a69bf89fea48bf`:
[CN](https://github.com/anomalyco/models.dev/blob/75c34eea924c565b39ea426730a69bf89fea48bf/providers/kimi-code-plan-cn/provider.toml),
[global](https://github.com/anomalyco/models.dev/blob/75c34eea924c565b39ea426730a69bf89fea48bf/providers/kimi-code-plan-global/provider.toml).
Both native providers declare `KIMI_API_KEY`; the separate CN variable is this
watcher's binding choice, not a native OpenCode setting. Both runtime listings
expose `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, and `k3-256k`.

Legacy local credential labels identify opaque profiles, not account issuers.
The two stored entries currently contain the same key and no issuer/region
metadata. Prior successful endpoint-specific catalogs establish access, not
issuing region or plan entitlement. Bind credentials according to their actual
issuer; this example does not choose a fallback host or change credentials.

The corrected example starts a unique `watch-state-v2/` baseline/report namespace.
Older reports retain their actual queried URLs/timestamps and original incorrect
regional labels; an appended correction documents the mistake. They are not
silently relabeled or reused as continuous native-provider baseline identities.

## Evidence and verification

Historical authenticated catalog GETs at **2026-10-03T23:00:57.678Z** returned
complete HTTP 200 responses: Zen 82 IDs, Go 36, Kimi `.com` 4 and `.ai` 4.
The final pre-label-correction poll reported 126 listed, three first absences,
and zero drift. First absences were Zen `nemotron-3-ultra-free` and `k2p5` at each
Kimi endpoint. They do not establish historical delisting. No inference ran.

A repeat poll previously exposed 118 false alarms involving only Zen/Go's
response-time `created` field. A timestamp-only mutation reproduced the bug RED;
the final projection excludes that field. Original reports and correction records
remain under `.ημ/diagnostics/provider-discovery/`. Earlier removed review-input
experiments and their diagnostics are historical evidence, not current scope.

Final reduced verification: **8 pure tests / 39 assertions** on Babashka, NBB and
compiled CLJS; **121 CLI integration/shape assertions**, zero failures. The integration
fixture invokes the actual command twice with a mutated authenticated catalog to
prove removal and alias/capability drift. It also exercises 401, 429, timeout,
partial/malformed catalogs, missing credentials, reflection, duplicate scopes,
TTL expiry and last-good preservation. Run it without live credentials:

```bash
nbb -cp src scripts/tests/catalog_watch.cljs
```

The read-only audit at `/tmp/catalog-provenance-audit-6j5ndde7` exposed replay
overwriting authenticated history and alias-ID fallback fabricating a target.
RED reproduced nine actual CLI/shape failures and two pure provenance failures.
GREEN also verifies fresh replay cannot delist from live history or create a live
baseline, spoofed provenance is overridden, unreadable live storage is never read
by replay, untagged legacy history is not promoted, and unknown-to-explicit target
metadata differs from two observed targets changing. Replaying the original audit
fixture also preserves its baseline byte-for-byte and makes no GET. Audit/diagnostic
history remains intact; model-only scope contains no reviewer-input semantics.

NBB 1.3.204 lacks bare `await`; the outer adapter uses its bundled Promesa. The
pure `.cljc` has no runtime dependency. Scoped clj-kondo and the runtime build
pass with zero warnings. No server/proxy data path or compiled export changes;
no generation, deployment or production proxy checks are part of this watcher.

## Bounded response reads and fixture cleanup — 2026-10-04

The transport now counts encoded response bytes while reading the native stream.
Exactly 2 MiB is accepted; a chunk that crosses the limit is not decoded or added
to the accumulated body. Overflow aborts the request, cancels the reader and
returns `invalid-response`, preserving the last-good authenticated baseline.
UTF-8 decoding retains partial characters between chunks. Existing deadlines,
credential-reflection checks, collection provenance and availability laws remain
unchanged. This remains an NBB outer adapter, without a new runtime export.

The integration runner now catches rejected setup/assertion flows, marks exit 1
without printing exception details, and always closes its own fixture server,
connections and temporary directory. It awaits cleanup instead of calling
`process.exit` before cleanup can run. The delayed-response fixture clears its
timer when the client disconnects.

Against immutable `acac3f0dacc46e07cd6a5c76f92a6dbbc2014b07`, the new transport
fixture produced **137 assertions / 5 semantic failures**: an actual 2,200,038-byte
UTF-8 body passed the old character-count limit and advanced its baseline, while
the old reader consumed the entire 16 MiB chunked body. Injecting a write rejection
after the test server listened left its temporary directory behind under Node 22's
default rejection policy; warning mode additionally hung until the bounded probe
terminated that owned child. Neither timeout nor uncaught termination is credited
as successful cleanup.

The repaired fixture passes **157 integration assertions**, including exact-limit
and one-byte-overflow cases, early connection cancellation, unchanged last-good
bytes, and child-process cleanup under both rejection policies. Existing pure
availability laws pass **8 tests / 39 assertions**; scoped clj-kondo reports zero
errors and warnings. The required `pnpm build` completes TypeScript and the
existing runtime target (**84 files, 0 compiled, 0 warnings**); the watcher itself
is exercised by the actual NBB command, not a new compiled export. These are
local tests, not native review approval.

Catalog documentation: [OpenCode Zen](https://opencode.ai/docs/zen/),
[OpenCode Go](https://opencode.ai/docs/go/),
[Kimi models](https://www.kimi.com/code/docs/en/kimi-code/models.html).
