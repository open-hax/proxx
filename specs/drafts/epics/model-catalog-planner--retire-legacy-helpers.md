# Sub-spec: Retire legacy monolith + helper sprawl

**Epic:** `model-catalog-planner-epic.md`
**SP:** 2
**Status:** Draft
**Priority:** P2
**Depends on:** `model-catalog-planner--attempt-executor-route-wiring.md` (4 SP)

## Scope

Delete the retired code: `legacy.ts`, the `provider-strategy.ts` monolith, the `fallback/` directory, and the seven helper-sprawl files. Relocate any still-needed imports to their new homes.

### Deletion targets

| File | Lines | Status at start of this spec |
|------|-------|------------------------------|
| `src/lib/provider-strategy/fallback/legacy.ts` | 1263 | `@deprecated`, no importers |
| `src/lib/provider-strategy/fallback/orchestrator.ts` | 132 | `@deprecated`, no importers |
| `src/lib/provider-strategy/fallback/credential-selector.ts` | 219 | absorbed into `RoutingPlanner` |
| `src/lib/provider-strategy/fallback/types.ts` | 111 | replaced by planner types |
| `src/lib/provider-strategy/fallback/index.ts` | ~5 | re-export shim |
| `src/lib/provider-strategy/fallback/error-classifier.ts` | 49 | moved to `providers/error-classifier.ts` |
| `src/lib/provider-strategy.ts` | 3126 | `@deprecated`, no importers |
| `src/lib/provider-utils.ts` | 301 | absorbed or dead |
| `src/lib/request-utils.ts` | 243 | absorbed or dead |
| `src/lib/model-routing-helpers.ts` | 113 | absorbed into `RoutingPipeline` |
| `src/lib/tenant-policy-helpers.ts` | 43 | absorbed into `policy/engine/` |
| `src/lib/response-utils.ts` | 97 | absorbed or dead |
| `src/lib/bridge-helpers.ts` | 87 | absorbed or dead |
| `src/lib/federation/federation-helpers.ts` | 85 | absorbed or dead |

**Total lines deleted:** ~5,874

### Import relocation

10 non-test import sites currently reference `provider-strategy.js`:

| File | Imports | New source |
|------|---------|------------|
| `src/routes/chat.ts` | `executeProviderFallback`, `inspectProviderAvailability`, `executeLocalStrategy`, `buildResponsesPassthroughContext` | `routing/AttemptExecutor`, `routing/RoutingPipeline`, `providers/adapters/` |
| `src/routes/responses.ts` | `executeProviderFallback`, `inspectProviderAvailability` | `routing/AttemptExecutor`, `routing/RoutingPipeline` |
| `src/routes/images.ts` | `executeProviderFallback`, `inspectProviderAvailability`, `buildImagesPassthroughContext` | `routing/AttemptExecutor`, `routing/RoutingPipeline` |
| `src/routes/embeddings.ts` | strategy types | `providers/ProviderAdapter` |
| `src/lib/routing-outcome-handler.ts` | `ProviderFallbackExecutionResult`, `ProviderAvailabilitySummary` | `routing/types` |
| `src/tests/sse-usage.test.ts` | `extractUsageCountsFromSseText` | `routing/usage-extraction` |

### Helper audit

Before deleting each helper-sprawl file, audit for still-needed exports:

1. `provider-utils.ts` (301 lines): Check each export against `rg` in `src/`. Dead exports → delete. Live exports → move to the focused module that needs them.
2. Repeat for each file.

### Duplication collapse

After deletion, verify that these previously-duplicated utilities have a single source:

| Utility | Single source after this spec |
|---------|-------------------------------|
| `isRecord` | `src/lib/type-guards.ts` (or inline) |
| `asString` / `asNumber` | `src/lib/type-guards.ts` (or inline) |
| `toSafeLimit` | `src/lib/routing/utils.ts` |
| `gptModelRequiresPaidPlan` | `src/lib/models/gpt-plan-gate.ts` |
| `selectProviderStrategy` | deleted (replaced by `ModelStrategy` + `RoutingPlanner`) |
| `buildResponsesPassthroughContext` | deleted (replaced by `ProviderAdapter`) |
| `buildImagesPassthroughContext` | deleted (replaced by `ProviderAdapter`) |

## Verification

- [ ] `src/lib/provider-strategy/fallback/` directory deleted
- [ ] `src/lib/provider-strategy.ts` deleted
- [ ] `src/lib/provider-utils.ts` deleted (or gutted to only live exports, moved)
- [ ] `src/lib/request-utils.ts` deleted
- [ ] `src/lib/model-routing-helpers.ts` deleted
- [ ] `src/lib/tenant-policy-helpers.ts` deleted
- [ ] `src/lib/response-utils.ts` deleted
- [ ] `src/lib/bridge-helpers.ts` deleted
- [ ] `src/lib/federation/federation-helpers.ts` deleted
- [ ] No `import` references to deleted files remain (verified by `rg`)
- [ ] No `isRecord`, `asString`, `asNumber`, `toSafeLimit` duplication across modules
- [ ] All 162 proxy tests pass
- [ ] `pnpm build` passes
