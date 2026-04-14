# Epic: Model Catalog Planner v1

**Status:** Draft
**Epic SP:** 22 (8 sub-specs ≤5 SP each)
**Priority:** P0
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Findings 2, 3
**Depends on:** `model-family-registry.md` (3 SP), `routing-pipeline-extraction.md` (3 SP remaining), `dead-code-model-routing-cleanup.md` (1 SP)
**Supersedes:** `dynamic-provider-model-discovery.md` (this epic absorbs its routing-architecture layer; the discovery/store layer remains authoritative there)
**Dependent SP (not counted below):** 7 SP across dependency specs

## Mission

Replace the hot-path fallback loop with **catalog-gated model-family/provider strategies**. No provider is ever attempted for a model it cannot serve. The word "fallback" survives only at API-compatibility alias boundaries, never inside the execution core.

## Problem statement

The current routing hot path lives in `src/lib/provider-strategy/fallback/legacy.ts` (1263 lines) and its twin `src/lib/provider-strategy.ts` (3126 lines). Both implement a **fallback execution model**: iterate providers in priority order, attempt each, retry or advance on failure. This has three architectural flaws:

1. **No admission gate.** The loop attempts providers regardless of whether they can serve the requested model. This produces unsupported-provider hammering, 404/422 spam, and wasted latency budgets.
2. **Fallback is the execution model.** "Upstream → fallback" is not a routing preference — it is the entire control flow. The spec in `dynamic-provider-model-discovery.md` already says upstream/fallback should be removed as a top-level concept and replaced with suitability scoring.
3. **Dual authority.** `provider-strategy.ts` and the split `provider-strategy/*` modules export overlapping strategy classes, `selectProviderStrategy` functions, and execution paths. This duplication is the single biggest tech-debt amplifier in the repo.

## Sub-specs

| # | Sub-spec | SP | Status | File | Depends on |
|---|----------|----|--------|------|------------|
| 1 | ModelCatalog admission gate | 3 | Draft | `epics/model-catalog-planner--catalog-admission-gate.md` | model-family-registry, routing-pipeline-extraction |
| 2 | ModelStrategy interface + Gpt5 + Claude strategies | 3 | Draft | `epics/model-catalog-planner--gpt5-claude-strategies.md` | #1 |
| 3 | GlmStrategy + OpenSourceModelStrategy | 2 | Draft | `epics/model-catalog-planner--glm-oss-strategies.md` | #2 |
| 4 | Provider adapter extraction | 3 | Draft | `epics/model-catalog-planner--provider-adapters.md` | #1 |
| 5 | SuitabilityScorer service | 2 | Draft | `epics/model-catalog-planner--suitability-scorer.md` | #1 |
| 6 | RoutingPlanner | 3 | Draft | `epics/model-catalog-planner--routing-planner.md` | #1, #2, #3, #5 |
| 7 | AttemptExecutor + route handler wiring | 4 | Draft | `epics/model-catalog-planner--attempt-executor-route-wiring.md` | #4, #6 |
| 8 | Retire legacy monolith + helper sprawl | 2 | Draft | `epics/model-catalog-planner--retire-legacy-helpers.md` | #7 |

### Dependency graph

```
#1 (catalog gate) ──┬──► #2 (Gpt5+Claude) ──► #3 (Glm+OSS) ──┐
                     ├──► #4 (adapters) ──────────────────────┤
                     └──► #5 (scorer) ────────────────────────┤
                                                           ▼
                                              #6 (RoutingPlanner)
                                                           │
                                                           ▼
                                           #7 (AttemptExecutor + wiring)
                                                           │
                                                           ▼
                                              #8 (Retire legacy)
```

Sub-specs #2, #4, #5 can proceed in parallel after #1.

## Target architecture

```
src/lib/
├── catalog/
│   ├── ModelCatalog.ts          # admission authority: "can provider X serve model Y?"
│   ├── ModelFamilyRegistry.ts   # canonical model-family inference + aliases
│   ├── ModelNameAliases.ts      # compatibility aliases (API boundary only)
│   └── PreferenceOverlay.ts     # models.json → preferred/disabled/alias
├── routing/
│   ├── RoutingPlanner.ts        # ranks only catalog-admitted providers
│   ├── AttemptExecutor.ts       # runs the ranked plan with retry/recovery
│   ├── RoutingPipeline.ts       # shared pipeline for chat/responses/images
│   └── SuitabilityScorer.ts     # TTFT, TPS, health, preference scoring
├── models/
│   ├── strategies/
│   │   ├── Gpt5Strategy.ts      # OpenAI, Factory, Requesty, OpenRouter (if proven)
│   │   ├── ClaudeStrategy.ts    # Anthropic, Factory
│   │   ├── GlmStrategy.ts       # ZAI, Rotussy, selected Ollama
│   │   └── OpenSourceModelStrategy.ts  # qwen, llama, gemma, deepseek-r1, gpt-oss, etc.
│   └── ModelStrategy.ts         # interface: eligibleProviders(), rankProviders()
├── providers/
│   ├── ProviderAdapter.ts       # interface: buildPayload, buildHeaders, handleResponse
│   ├── adapters/
│   │   ├── OpenAiAdapter.ts
│   │   ├── FactoryAdapter.ts
│   │   ├── GeminiAdapter.ts
│   │   ├── OllamaAdapter.ts
│   │   └── StandardAdapter.ts
│   └── error-classifier.ts      # preserved from fallback/error-classifier.ts
└── control-plane/               # UI/admin routes (unchanged scope)
```

## Data flow

```
Request
  │
  ▼
RoutingPipeline (shared across chat/responses/images)
  │
  ├─► resolveModelRouting()     ← from routing-pipeline-extraction spec
  │     tenant check, alias resolution, disabled check
  │
  ├─► RoutingPlanner.plan()
  │     ├─► ModelCatalog.providersForModel()
  │     │     hard gate: only catalog-admitted providers
  │     ├─► ModelFamilyRegistry.inferFamily()
  │     │     canonical family inference
  │     ├─► ModelStrategy.eligibleProviders()
  │     │     family-specific eligibility filter
  │     ├─► credential resolution (policy, quota, latency)
  │     └─► ModelStrategy.rankProviders(scorer)
  │           suitability-scored ranking
  │
  ├─► AttemptExecutor.execute(plan)
  │     ├─► ProviderAdapter.buildPayload()
  │     ├─► ProviderAdapter.applyRequestHeaders()
  │     ├─► upstream fetch
  │     ├─► ProviderAdapter.handleProviderResponse()
  │     └─► retry/skip/return per error classification
  │
  └─► handleRoutingOutcome()    ← from routing-pipeline-extraction spec
        error summary, streaming setup, response writing
```

## Invariants

1. **No provider is ever attempted for a model it cannot serve.** The `ModelCatalog.canServe()` gate is mandatory before any upstream fetch.
2. **Family inference has exactly one authority.** All consumers import from `ModelFamilyRegistry`. No other module defines prefix lists or family heuristics.
3. **Compatibility aliases live only at API boundaries.** `ModelNameAliases` applies at request parsing time. No alias logic inside `RoutingPlanner`, `AttemptExecutor`, or `ProviderAdapter`.
4. **The word "fallback" does not appear in execution-core module names or types.** It may appear in API-compat re-exports and documentation referencing the migration.
5. **Provider adapters don't route.** `ProviderAdapter` translates requests/responses. Routing decisions belong to `ModelStrategy` + `RoutingPlanner`.
6. **The monolith (`provider-strategy.ts`) and the split modules (`provider-strategy/*`) must not coexist as authorities.** After sub-spec 7, only the new architecture survives.

## Countermoves

| Risk | Mitigation |
|------|------------|
| Catalog is stale → false negative → model rejected | Stale providers remain in catalog with `stale: true` flag; planner includes stale providers with a score penalty, not exclusion |
| New provider added → not in catalog → can't serve | Catalog refresh interval is tunable; manual refresh endpoint for ops |
| Strategy returns empty eligible set for a valid model | OpenSourceModelStrategy acts as catch-all: any provider that the catalog admits for an unrecognized family is eligible |
| Migration breaks existing behavior | Sub-spec 1 starts with pass-through (logs but doesn't gate); sub-spec 7 uses feature flag for parallel run before cutover |
| Scorer has no data for new provider+model | Cold-start: scorer returns neutral score; ranking falls back to preference overlay order |

## Definition of done

- [ ] `ModelCatalog.canServe()` gates all routing attempts
- [ ] No provider is attempted for a model it cannot serve (verified by integration test)
- [ ] `ModelFamilyRegistry` is the sole authority for family inference (verified by `rg`)
- [ ] `src/lib/provider-strategy/fallback/legacy.ts` deleted
- [ ] `src/lib/provider-strategy.ts` deleted
- [ ] `chat.ts` < 350 lines, `responses.ts` < 300 lines, `images.ts` < 150 lines
- [ ] Catalog fetched exactly once per request
- [ ] All 162 proxy tests pass
- [ ] No `isRecord`, `asString`, `asNumber`, `toSafeLimit` helper duplication across modules (single source each)

## References

- `specs/drafts/dynamic-provider-model-discovery.md` — discovery store + preference overlay design
- `specs/drafts/model-family-registry.md` — unified family inference spec
- `specs/drafts/routing-pipeline-extraction.md` — shared routing pipeline extraction
- `specs/drafts/app-composition-slimming-v2.md` — app composition dedup
- `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` — original audit findings
- `src/lib/provider-strategy/fallback/legacy.ts` — retirement target
- `src/lib/provider-strategy.ts` — retirement target
- `src/lib/provider-strategy/registry.ts` — strategy registry (preserved, refactored)
- `src/lib/provider-strategy/strategies/` — existing strategy classes (absorbed into adapters)
