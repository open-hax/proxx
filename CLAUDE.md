# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Proxx is an OpenAI-compatible proxy server (`@open-hax/proxx`) with provider-scoped account rotation, multi-provider routing, federation, and a WebSocket bridge. It exposes `POST /v1/chat/completions`, `/v1/responses`, `/v1/models`, and a React/Vite web console.

## Commands

### Development
```bash
pnpm dev                    # build CLJS then run TypeScript server via tsx
pnpm web:dev                # Vite dev server for the web console
```

### Build
```bash
pnpm build                  # full build: TS + CLJS
pnpm build:ts               # TypeScript only
pnpm build:cljs             # shadow-cljs only
pnpm web:build              # build React web console
```

### Type checking and linting
```bash
pnpm typecheck              # tsc --noEmit
pnpm lint                   # eslint
pnpm lint:errors            # eslint --quiet (errors only)
./scripts/ci-lint.sh        # full lint + actionlint on workflows
```

### Tests
```bash
pnpm test                             # build then run all unit tests
npx tsx --test src/tests/<file>.test.ts  # run a single TS test file
pnpm test:cljs                        # compile and run CLJS unit tests
npx tsx --test src/tests/schema-migration.test.ts  # migration-specific tests
pnpm web:test                         # Vitest frontend unit tests
pnpm web:test:e2e                     # frontend browser smoke tests
PROXY_AUTH_TOKEN=<token> npx tsx --test src/tests/proxy.test.ts  # live proxy test (requires running instance)
```

### E2E and load
```bash
pnpm test:e2e               # end-to-end smoke
pnpm test:e2e:multitenancy  # multi-tenancy smoke
pnpm test:e2e:federation    # federation cluster test
pnpm test:load              # load test
```

### Full pre-PR validation
```bash
pnpm validate:required      # build + web build + web tests + proxy test (requires PROXY_AUTH_TOKEN)
```

## Architecture: The Critical Mental Model

**This is a polyglot codebase. Routing logic is NOT in TypeScript.**

```
HTTP Edge (TypeScript) → CLJS Runtime Boundary → Declarative Policy Engine (EDN + CLJS)
```

### Where to look for what

| What | Where |
|------|-------|
| HTTP routes, request parsing, response serialization | `src/routes/`, `src/app.ts` |
| Database queries (postgres.js) | `src/lib/db/` |
| Routing decisions, provider selection, account ordering | `resources/policies/runtime/*.edn` + `src/proxx/**/*.cljs` |
| CLJS→TypeScript interop boundary | `src/lib/cljs-runtime.ts` (loads `dist/cljs/proxx-runtime.js`) |
| Model pricing overrides | `resources/policies/runtime/15-model-pricing-overrides.edn` only |

### Policy files (loaded in order via `00-manifest.edn`)

| File | Purpose |
|------|---------|
| `00-domain.edn` | Enums, scoring tables, defaults |
| `05-provider-seed.edn` | Provider env var specs |
| `10-model-families.edn` | Model-family pattern matching |
| `15-model-pricing-overrides.edn` | Token price overrides (EDN only — no JSON blobs or TS tables) |
| `20-provider-capabilities.edn` | Per-provider strategy preferences |
| `30-model-routing.edn` | Core routing clauses (family → provider → strategy) |
| `40-strategy-selection.edn` | Strategy selection rules |
| `50-account-selection.edn` | Account ordering constraints |
| `60-tenant-enforcement.edn` | Tenant authorization |
| `65-federation-routing.edn` | Federation relay admission |
| `70-request-queue-templates.edn` | Queue concurrency/timeout/backoff |
| `90-router.edn` | Root policy program and strategy bindings |

More-specific clauses must precede catch-alls. EDN changes take effect on server restart (no CLJS rebuild needed unless interpreter code changes).

### Key CLJS namespaces

`proxx.runtime` is the JS interop boundary. TypeScript calls it for: `routePolicy`, `runQueued`, `resolveQueuePolicy`, `resolveModelAlias`, `normalizeReasoningRequest`, `previewPolicyDecision`, and related functions. Do not add routing or queue logic to TypeScript — it belongs in CLJS/EDN.

### shadow-cljs builds

- `:runtime` — ESM module output to `dist/cljs/proxx-runtime.js`, consumed by the TypeScript server
- `:node-test` — CJS test runner to `target/node-test.cjs`

## Mandatory Completion Checks

### Backend changes (routes, auth, routing, data path)
1. `pnpm build`
2. `PROXY_AUTH_TOKEN=$(grep PROXY_AUTH_TOKEN /home/err/devel/services/proxx/.env | cut -d= -f2) npx tsx --test src/tests/proxy.test.ts`

### Frontend changes (`web/`)
1. `pnpm web:build`
2. `pnpm web:test`
3. `pnpm web:test:e2e`

### Schema migrations
1. Add SQL to `ALL_MIGRATIONS` in `src/lib/db/schema.ts` (single source of truth). Use `IF NOT EXISTS`.
2. Bump `SCHEMA_VERSION`.
3. `npx tsx --test src/tests/schema-migration.test.ts`
4. Apply SQL directly to the running DB before restarting.

### CLJS changes
1. `pnpm build` (triggers shadow-cljs compilation)
2. Verify output in `dist/`

## Branch and PR Policy

- **All work branches from `staging`** and PRs target `staging`.
- `main` only accepts promotion PRs from `staging`. Do not open feature/fix PRs directly against `main`.
- CI on `staging` PRs runs: `staging-typecheck`, `staging-unit-tests`.
- CI on `main` PRs (promotion only) runs the full gate including build, web build, and `staging-promotion-gate`.

## Rules for Adding Routing Behavior

1. Add/extend a `:model-family` contract in `10-model-families.edn`
2. Add a `:routing-clause` in `30-model-routing.edn`
3. Add provider capabilities if needed in `20-provider-capabilities.edn`
4. Add strategy binding if needed in `90-router.edn`
5. Do not add routing switches to `.env`, Compose files, or TypeScript conditionals.
6. `models.json` is preference metadata only — not a routing source of truth.

## ClojureScript Style

- New async CLJS code uses `defn ^:async` / `deftest ^:async` with bare `(await ...)`.
- Do not use `shadow.cljs.modern/js-await` in new code.
- New queue logic belongs in `src/proxx/queue/*` and `resources/policies/runtime/*.edn`, not TypeScript.
