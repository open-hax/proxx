# Sub-spec: SuitabilityScorer service

**Epic:** `model-catalog-planner-epic.md`
**SP:** 2
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--catalog-admission-gate.md` (3 SP)

## Scope

Create a standalone `SuitabilityScorer` that computes per-(provider, model) scores from existing EWMA metrics. This is the scoring system from `dynamic-provider-model-discovery.md` §3, wired into real metric stores.

### New code

```typescript
// src/lib/routing/SuitabilityScorer.ts

export interface SuitabilityScorer {
  /** Compute a suitability score for a provider+model pair. Higher is better. */
  score(providerId: string, modelId: string): number;

  /** Record a TTFT observation for a provider+model pair. */
  recordTtft(providerId: string, modelId: string, ms: number): void;

  /** Record a TPS observation for a provider+model pair. */
  recordTps(providerId: string, modelId: string, tps: number): void;

  /** Record a request outcome (success/failure) for a provider+model pair. */
  recordOutcome(providerId: string, modelId: string, success: boolean): void;
}
```

### Scoring algorithm (v1)

```
score(provider, model) =
  if provider has no catalog entry for model: -Infinity
  else:
    base = 0
    + provider_health_bonus       // EWMA success rate * weight_health (0.3)
    + model_health_bonus          // per-(provider, model) success rate * weight_model_health (0.3)
    + ttft_bonus                  // -log(TTFT_ms / 1000) * weight_ttft (0.2), lower TTFT is better
    + tps_bonus                   // log(TPS + 1) * weight_tps (0.1), higher TPS is better
    + preference_bonus            // +0.1 if model is in PreferenceOverlay.preferred
    + stale_penalty               // -0.2 if provider catalog entry is stale
```

### Data sources

The scorer reads from three existing stores:

| Metric | Source | Current location |
|--------|--------|-----------------|
| Provider health | `AccountHealthStore` | `src/lib/db/account-health-store.ts` |
| Request-level metrics | `RequestLogStore` | `src/lib/db/request-log-store.ts` |
| Affinity/pheromone | `ProviderRoutePheromoneStore` | `src/lib/provider-route-pheromone-store.ts` |
| Preference data | `PreferenceOverlay` | New (from sub-spec 1) |

The scorer does **not** duplicate these stores. It reads from them and maintains only lightweight EWMA state for TTFT and TPS (which aren't currently tracked per-provider-per-model).

### Cold-start behavior

When no metrics exist for a provider+model pair:
- `score()` returns **0** (neutral). Ranking falls back to `ModelStrategy.rankProviders()` default order and preference overlay.
- First request seeds the EWMA. After 2-3 requests, scores stabilize.

### Integration point

- `RoutingPlanner.plan()` passes `SuitabilityScorer` to `ModelStrategy.rankProviders()`.
- `AttemptExecutor` calls `recordTtft()`, `recordTps()`, `recordOutcome()` after each attempt to feed the scorer.

## Verification

- [ ] `src/lib/routing/SuitabilityScorer.ts` created with `score()`, `recordTtft()`, `recordTps()`, `recordOutcome()`
- [ ] Unit test: score returns `-Infinity` for unknown provider+model
- [ ] Unit test: score returns `0` for known provider with no metrics (cold start)
- [ ] Unit test: score increases with higher health, lower TTFT, higher TPS
- [ ] Unit test: stale catalog entry incurs penalty
- [ ] Unit test: preferred model gets preference bonus
- [ ] Unit test: `recordTtft()` and `recordTps()` update EWMA state correctly
- [ ] `pnpm build` passes
