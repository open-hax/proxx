# Proxx: OpenAI-compatible proxy with a declarative EDN/CLJS policy engine

This file is the single source of truth for every agent harness (Codex, OpenCode, and Claude Code through the `@AGENTS.md` import in `CLAUDE.md`). Keep shared rules here.

Proxx (`@open-hax/proxx`) is an OpenAI-compatible proxy server with provider-scoped account rotation, multi-provider routing, federation and a WebSocket bridge. It serves `POST /v1/chat/completions`, `/v1/responses`, `/v1/models`, and a ClojureScript (Reagent) web console bundled with Vite.

## Read this first: where decisions live

This is a Clojure shop. The runtime is ClojureScript; no TypeScript remains. Routing, queue policy, provider selection, account ordering and model-family classification are never imperative edge code. They live in:

1. **Declarative EDN contracts** in `resources/policies/runtime/*.edn`
2. **ClojureScript interpreters** in `src/proxx/**/*.clj[cs]`

The system uses a data-as-interpreter pattern, so grepping for "if model starts with gpt- then…" finds nothing:

- **Facts**: EDN declares what is true (model families, provider capabilities, routing preferences).
- **Rules**: EDN declares what should happen (routing clauses, strategy selection, account ordering).
- **Interpreter**: CLJS (`proxx.policy`, `proxx.policy.contracts`, `proxx.policy.router`) evaluates them against runtime context.

Routing if/then chains are in `resources/policies/runtime/30-model-routing.edn`, not in edge code. Data over code; declaration over implementation; new logic belongs in EDN or CLJS.

## ABSOLUTE POLICY BOUNDARY: EDN DSL or CLJS interpreter only

Provider/model facts and rules are forbidden outside EDN contracts and the CLJS policy interpreter. That covers TypeScript, the HTTP edge (`src/proxx/http/`, `src/proxx/runtime/routes/`), `.env`, Compose files and ad-hoc conditionals. Forbidden concepts include:

- model-family or provider-family classification
- model-to-provider routing; provider ordering or filtering
- strategy preference by provider/model
- dynamic/local/Ollama/cloud special cases
- booleans like `wantsDynamicOllamaRoutes`
- helpers like `discoverDynamicOllamaRoutes`, `prependDynamicOllamaRoutes`, `filterDedicatedOllamaRoutes`, `resolveProviderRoutesForModel`, `providerIdLooksLikeOllama`

The EDN runtime policy files are a declarative programming language and CLJS interprets it. No other layer may re-create fragments of the interpreter or make shadow routing decisions. Model pricing overrides live only in `15-model-pricing-overrides.edn` (no JSON blobs or code tables). `models.json` is preference metadata only, not a routing source of truth.

Mechanical enforcement: `pnpm run check:no-new-typescript` fails on any TypeScript-family file (`scripts/typescript-inventory-allowlist.json` is empty) and runs `scripts/check-policy-boundary.mjs` against forbidden routing helpers. If a change needs one of these concepts, change EDN contracts and CLJS interpreter behavior instead of weakening the gate.

## Architecture

```
HTTP edge (CLJS: Ring on Fastify) → proxx.runtime boundary → Declarative policy engine (EDN + CLJS)
```

| What | Where |
|------|-------|
| HTTP routes, request parsing, response serialization | `src/proxx/runtime/routes/`, `src/proxx/http/` |
| Composition, server entry (`node dist/cljs/main.js`), shutdown | `src/proxx/app/main.cljs`, `src/proxx/app/entry.cljs`; host in `src/proxx/host.cljs` |
| Database queries (postgres.js) | `src/proxx/runtime/sql*.cljs`, `src/proxx/credentials/sql.cljc` |
| Routing decisions, provider selection, account ordering | `resources/policies/runtime/*.edn` interpreted by `src/proxx/**` |
| Web console | `src/proxx/web/` (CLJS); Vite shell, styles and tests in `web/` |

| Namespace | Responsibility |
|-----------|---------------|
| `proxx.boot` | Pipeline construction, store initialization, seed ingestion |
| `proxx.pipeline` | Read/write chain-of-custody through hot/redis/lmdb/postgres stores |
| `proxx.store.*` | Store protocol implementations (hot, redis, lmdb, postgres) |
| `proxx.cache-policy` | Declarative cache policies per entity type (TTL, write-through, read-order) |
| `proxx.processor` | Key normalization, provenance stamping, affinity state machine, pheromone scoring |
| `proxx.schema` | Malli schemas for all entities and policy contracts |
| `proxx.policy.loader` | Load and validate EDN policy manifests and contracts |
| `proxx.policy` | Contract registries, eval forms, node evaluation, strategy dispatch |
| `proxx.policy.eval` | Pure form evaluator for policy conditions |
| `proxx.policy.contracts` | Compile contracts into runtime indexes (routing clauses, provider routes, …) |
| `proxx.policy.router` | Route a request through the compiled policy tree |
| `proxx.policy.evidence` | Load external evidence (models.dev, provider snapshots) for policy context |
| `proxx.queue.policy` | Pure queue policy (backoff, timeout, retry classification) |
| `proxx.queue.runtime` | Mutable queue runtime (concurrency slots, waiters, retry loop) |
| `proxx.strategies.*` | Strategy implementations (OpenAI passthrough, Anthropic messages) |
| `proxx.runtime` | JS-interop boundary: `routePolicy`, `runQueued`, `resolveQueuePolicy`, `resolveModelAlias`, `normalizeReasoningRequest`, `previewPolicyDecision`, … |

The host and route edge call the policy engine and queue through `proxx.runtime`.

## Declarative policy layer (`resources/policies/runtime/`)

Loaded in the order declared by `00-manifest.edn`:

| File | Content |
|------|---------|
| `00-domain.edn` | Enums, scoring tables, default strategy order, provider sets |
| `05-provider-seed.edn` | Provider seed specs (env var names, fallback IDs) |
| `06-proxy-config-defaults.edn` | Proxy config fall-backs (upstream URLs, prefixes, paths, OAuth defaults, `/v1/models` catalogue); env vars win |
| `10-model-families.edn` | Model-family patterns and reasoning controls |
| `15-model-pricing-overrides.edn` | Token pricing overrides |
| `16-model-pricing-resolution.edn` | Pricing snapshot location, provider/vendor fallbacks, energy profiles |
| `17-provider-quota-profiles.edn` | Where and how provider account quota/liveness is read |
| `18-auto-model-profile.edn` | `auto:cheapest\|fastest\|smartest\|healthiest` selection facts |
| `20-provider-capabilities.edn` | Provider capability clauses (strategy preferences/exclusions) |
| `30-model-routing.edn` | **Routing clauses**: providers/strategies/accounts per model family |
| `40-strategy-selection.edn` | Strategy selection rules |
| `50-account-selection.edn` | Account ordering constraints (plan weights, free-tier preference) |
| `60-tenant-enforcement.edn` | Authorization clauses (model allow-lists, provider disabled lists) |
| `65-federation-routing.edn` | Federation relay admission and projected-account order |
| `70-request-queue-templates.edn` | Queue templates and instances (concurrency, timeout, backoff) |
| `75-provider-wire-profiles.edn` | How non-standard upstreams are addressed |
| `76-provider-surface-facts.edn` | Which providers speak which API, catalog locations, bridge paths |
| `77-upstream-attempt-policy.edn` | How one upstream attempt is judged and what it costs the credential |
| `78-strategy-registry.edn` | Upstream strategy priority (first match wins) |
| `79-auto-model-chains.edn` | Fallback-chain auto models (`auto:vision`, `auto:cephalon…`) |
| `80-rate-limit-classification.edn` | Provider rate-limit classification |
| `90-router.edn` | Root policy program and strategy bindings |

**Invariant**: files append/override in order. Facts first, derived rules next, root router last. More-specific clauses precede catch-all clauses.

Policy EDN is runtime data read at process start: an EDN-only change needs a server restart, not a CLJS rebuild (interpreter changes do need one). The running process must be able to read `resources/`; never strip it from container builds. `PROXX_CLJS_POLICY_MANIFEST` / `PROXY_CLJS_POLICY_MANIFEST` override the manifest path.

## The policy DSL

Contracts are EDN maps with `:contract/id` and `:contract/kind`. Common kinds: `:model-family` (pattern classification, e.g. `:match/model-pattern "^gpt-"`), `:model`, `:provider-route`, `:provider-capability`, `:routing-clause` (family → preferred providers → strategies → account ordering), `:request-queue-template` / `:request-queue-instance`, `:policy-program` and `:strategy-binding`. Custom logic is a contract kind registered in `proxx.policy` (e.g. `:model-family`, `:provider-capability`, `:authorization-clause`).

Routing, declared in EDN and evaluated by CLJS: derive request facts (model ID, tenant settings) → enforce tenant authorization (`:authorization-clause`) → derive the model family → choose the first matching `:routing-clause` → filter provider candidates (exclusions, tenant allow-lists, catalog availability) → order them (preferred first, then original order) → choose the provider strategy (capabilities ∩ route preferences) → filter accounts (plan constraints, quota exhaustion) → order accounts (free-tier preference, plan scoring) → execute the strategy through its bound CLJS function.

Conditions use a restricted eval language, not arbitrary CLJS:

```clojure
{:eval/op :all               ; :all :some :none :not :assert
 :eval/forms [(= ctx.it.provider-id "openai")
              (contract/apply [:model-family :model-family/gpt] ctx.it.model-id)]
 :eval/target :providers}    ; optional: evaluate against each item in ctx target
```

Available ops: `=`, `not`, `and`, `or`, `get`, `get-in`, `first`, `second`, `keyword`, `str`, `some?`, `nil?`, `clojure.string/includes?`, `clojure.string/split`, `clojure.string/starts-with?`.

### Adding routing behavior

1. Add or extend a `:model-family` contract in `10-model-families.edn`.
2. Add a `:routing-clause` in `30-model-routing.edn` (more specific before catch-alls).
3. Add provider capabilities if needed in `20-provider-capabilities.edn`.
4. Add a strategy binding if needed in `90-router.edn`.
5. Never add routing switches to `.env`, Compose files or code conditionals.
6. Test: `pnpm build` and `pnpm test:cljs` (proxy suite under `test/proxx/proxy/`).
7. Validate decisions with `proxx.policy.contracts/preview-policy-decision` (`previewPolicyDecision` in `proxx.runtime`).

### Request queue

The queue runtime lives in `src/proxx/queue/*` and is exposed through `proxx.runtime`. New queue semantics belong there, never in route code: routes call `runQueued` / `resolveQueuePolicy` and keep only minimal HTTP response mapping. Queue policies belong in `resources/policies/runtime/*.edn`, loaded through `00-manifest.edn`.

## ClojureScript style

- New async code uses `defn ^:async` / `deftest ^:async` with bare `(await ...)`.
- Do not add `shadow.cljs.modern/js-await` to new code.
- Tests prefer `deftest ^:async` over `cljs.test/async` callbacks for Promise flows.
- Compile immediately after changing async CLJS; never rewrite working `^:async` code into Promise-chain helpers or another language.

## Commands

```bash
pnpm dev                     # build CLJS, then run node dist/cljs/main.js (.env if present)
pnpm web:dev                 # build the :web bundle, then the Vite dev server
pnpm web:watch               # shadow-cljs watch :web
pnpm build                   # clean dist/, shadow-cljs release :runtime
pnpm web:build               # shadow-cljs release :web + Vite -> web/dist
pnpm check:no-new-typescript # TypeScript inventory + policy boundary gates
pnpm lint:errors             # eslint, errors only (pnpm lint for warnings too)
./scripts/ci-lint.sh         # deployment-boundary and container-runtime checks, shellcheck
pnpm test                    # build, then test:cljs with a 4 GB heap
pnpm test:cljs               # compile :node-test, run target/node-test.cjs
pnpm test:coverage           # c8 coverage over :node-test
pnpm web:test                # :web-test view smoke tests under jsdom
pnpm web:test:e2e            # Playwright browser smoke (web/test/e2e/tools.smoke.mjs)
pnpm test:e2e                # live end-to-end smoke (also :multitenancy, :federation, :federation:audit)
pnpm test:load               # load test
pnpm validate:required       # build + web:build + web:test + web:test:e2e (no test:cljs)
```

shadow-cljs builds: `:runtime` (ESM to `dist/cljs/`: the `proxx-runtime` module plus the `main` Node entry, `proxx.app.entry/start!`), `:node-test` (`target/node-test.cjs`, namespaces `proxx.*-test`), `:node-e2e` (`target/node-e2e.cjs`, no package script), `:web` (`web/public/js/main.js`; Vite copies `public/` into `web/dist`), `:web-test` (`proxx.web.*-smoke`, run with `web/test/jsdom-setup.cjs`) and `:bulk-oauth-import` (`pnpm import:oauth:bulk`).

## CRITICAL: database migration workflow

Before rebuilding or restarting after any schema change:

1. Add the migration to `:migrations` in `resources/db/schema.edn`, the single source of truth (read by `proxx.db.schema` and `proxx.runtime.db-schema`). Every statement is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). Never edit an existing statement: `test/proxx/db/schema_test.cljs` pins every text by digest.
2. Bump `:schema-version` to the new highest version in `:migrations`.
3. Run `pnpm test:cljs`: it catches version drift, missing `IF NOT EXISTS` and ordering errors.
4. Build with `pnpm build`.
5. Apply the SQL directly to any running database, then rebuild/recreate the container.

Never hardcode migration SQL in the runner (`proxx.runtime.db-schema/run-migrations-js`) or anywhere outside `:migrations`: SQL that bypasses the list records a schema version without applying the migration. `DEVEL.md` > "Database Migrations" explains the design; its `src/lib/db/schema.ts` references predate the CLJS rewrite.

## CRITICAL: completion requires testing

Do not mark work complete without running the relevant tests/builds for every surface you changed.

- **Backend** (routes, auth, routing, data path, CLJS): `pnpm build`, then `NODE_OPTIONS=--max-old-space-size=4096 pnpm test:cljs` (includes the end-to-end proxy tests under `test/proxx/proxy/`). Check the compiled output in `dist/cljs/` or `target/`.
- **Frontend** (`src/proxx/web/`, `web/`): `pnpm web:build`, `pnpm web:test`, `pnpm web:test:e2e`.
- **Schema migrations**: the migration workflow above, including `pnpm test:cljs`.
- **Container/packaging** (`Dockerfile`, `ecosystem.container.config.cjs`, Compose files, frontend deps, build context): `./scripts/ci-lint.sh`, build the root `Dockerfile` (the image Services deploys), recreate the container, then check `curl http://localhost:8789/health` and `curl -I http://localhost:5174`.
- `pnpm web:test` is the fast render-smoke layer; pure console logic is tested by `pnpm test:cljs`. `pnpm web:test:e2e` locks the console surfaces built on `@open-hax/uxx`.
- If a touched surface has no test yet, add at least a smoke test first.

## Branches, PRs, CI and deployment

- **`main` is the single trunk.** Branch from `main` and target PRs at `main`. There is no `staging` branch, promotion PR or deployed test environment.
- CI on PRs to `main` (`.github/workflows/main-pr-gate.yml`): `main-lint` (`ci-lint.sh`, actionlint, `lint:errors`), `main-typecheck` (`check:no-new-typescript`), `main-unit-tests` (`pnpm test`), `main-coverage` (80% line threshold), `main-build`, `main-web-build`.
- Deployment is not done here. `open-hax/services` builds Proxx from a ref using the root `Dockerfile` and deploys the stack. Keep the `Dockerfile`, the `dist/cljs/main.js` start command and `/health` working, and say so in the PR when a change affects them. See `docs/deployment-ownership.md`.
- Kanban sync, Kimi/CodeRabbit review and review-gate rules: `docs/agent-workflows.md`.
- Version bumps in `package.json` follow semver (MAJOR breaking API, MINOR new feature/endpoint, PATCH fix). Release steps: `docs/operator-reference.md`.
- Receipt River: append to `.ημ/receipts.edn`. Never rewrite it or the older root `receipts.edn` / `receipts.log`.

## Credentials and secrets

- Provider credentials stay local to the instance that owns them. Never copy OAuth refresh tokens or credential-bearing tables to another host; share access through federation projection or the WebSocket bridge.
- Never print or copy webhook URLs, bot/GitHub tokens, provider keys or other secrets into logs, issues, PR comments or commits.

## Operator reference

Federation modes A–D, health and federation-status checks, the OpenAPI contract, release steps and troubleshooting: `docs/operator-reference.md`.
