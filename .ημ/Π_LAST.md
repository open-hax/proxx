# Π Snapshot: Migration pipeline + routing cleanup handoff

- **Repo:** `open-hax/proxx`
- **Branch:** `fork-tax/20260330-205903-aco-route-quota-cooldowns`
- **Previous tag:** `Π/20260330-205903-aco-route-quota-cooldowns`
- **Intended Π tag:** `Π/20260402-184515-migration-pipeline-routing-cleanup`
- **Generated:** `2026-04-02T18:45:15Z`

## What this snapshot preserves

This Π handoff captures a full audit and remediation pass triggered by a proxx container crash. The root cause was a schema migration (v7 `disabled` column) that was recorded in `schema_version` but never applied because `runMigrations()` hardcoded SQL instead of iterating `ALL_MIGRATIONS`.

### Migration pipeline fix
- `src/lib/db/sql-credential-store.ts` — `runMigrations()` now iterates `ALL_MIGRATIONS` (single source of truth)
- `src/tests/schema-migration.test.ts` — 5 tests enforcing version/SQL consistency
- `DEVEL.md` / `AGENTS.md` — migration workflow documented for humans and agents

### Dead code removal
- Deleted `src/lib/model-selection-policies.ts` (62 lines, never imported)
- Deleted `src/lib/provider-route-policies.ts` (170 lines, never imported)

### Fastify type augmentation
- New `src/lib/fastify-types.ts` — `declare module "fastify"` for `openHaxAuth` + `_otelSpan`
- Removed 55 ad-hoc type casts across 19 route files
- Removed `DecoratedAppRequest` local type from `app.ts`

### Model family registry
- New `src/lib/model-family.ts` — unified `inferModelFamily`/`looksLikeHostedOpenAiFamily`/`requestyModelProvider`
- Updated `src/lib/provider-strategy/fallback.ts` — removed local `REQUESTY_MODEL_PREFIXES` + `requestyModelPrefix`

### Routing outcome handler extraction
- New `src/lib/routing-outcome-handler.ts` — shared error-handling block
- `chat.ts` 498→428, `responses.ts` 434→365, `images.ts` 210→134 (215 lines eliminated)

### App.ts cleanup
- Batched ~20 inline OPTIONS handlers into a loop
- Removed `DecoratedAppRequest` type alias

### MCP status fix
- `src/routes/api/v1/index.ts` — MCP endpoint changed from `"implemented"` to `"planned"`

### Specs
- `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` — 9 findings report
- 6 remediation specs (17 SP total)

## Verification

- TypeScript build: `tsc -p tsconfig.json` ✅ (zero errors)
- Tests: `schema-migration.test.ts` + `model-routing-helpers.test.ts` ✅ (10/10 pass)

## Deferred

- Token refresh extraction from `app.ts` (needs live OAuth testing)
- `AppDeps` / `UiRouteDependencies` unification (needs dedicated session)
