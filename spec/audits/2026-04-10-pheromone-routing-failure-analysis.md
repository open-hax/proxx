# Pheromone Routing Failure Analysis

**Date:** 2026-04-10
**Trigger:** `glm-4.5-flash` and `glm-4.7-flash` requests flooding ollama-cloud (207K+ failures) despite zai having pheromone=1.0
**Status:** Root cause identified; architectural remediation plan proposed

---

## Signal

The `UPSTREAM_FALLBACK_PROVIDER_IDS=ollama-cloud,rotussy,zai,requesty` causes **ollama-cloud** to be tried first for every non-prefixed model request. The pheromone/ACO system only influences **dedicated Ollama routes** (provider IDs starting with `ollama-` but not `ollama-cloud`), not the primary fallback chain.

**Result:** 207,130 failed requests to ollama-cloud for `glm-4.5-flash` while zai sat ready with pheromone=1.0 and 0 failures.

---

## Evidence Trail

### 1. The Fallback Chain is Static

From `provider-routing.ts:buildProviderRoutes()`:

```typescript
const providerIds = includeOpenAiFallback
  ? [config.upstreamProviderId, config.openaiProviderId, "factory", ...config.upstreamFallbackProviderIds]
  : [config.upstreamProviderId, "factory", ...config.upstreamFallbackProviderIds];
```

This builds routes in **env-declared order**, no learning involved.

### 2. ACO Only Ranks Dedicated Ollama Routes

From `provider-route-aco.ts:rankProviderRoutesWithAco()`:

```typescript
const dedicatedRoutes = input.providerRoutes.filter(routeLooksLikeDedicatedOllama);
const passthroughRoutes = input.providerRoutes.filter((route) => !routeLooksLikeDedicatedOllama(route));

// ... ACO ranking only applied to dedicatedRoutes ...
// passthroughRoutes are appended unchanged

return {
  orderedRoutes: [...orderedDedicated.map((candidate) => candidate.route), ...passthroughRoutes],
  signals: orderedDedicated.map(...)
};
```

**Critical bug:** `routeLooksLikeDedicatedOllama()` returns `true` only for providers matching `/^ollama-(?!cloud$)/`. All other providers bypass ACO entirely.

### 3. Chat.ts Routing Pipeline (Simplified)

```typescript
// 1. Build static routes from env
providerRoutes = await buildProviderRoutesWithDynamicBaseUrls(...);

// 2. Filter by catalog (but GLM bypasses this!)
if (!context.openAiPrefixed && resolvedModelCatalog) {
  providerRoutes = resolveProviderRoutesForModel(providerRoutes, context.routedModel, resolvedModelCatalog);
}

// 3. Policy ordering (uses model rules, not pheromones)
providerRoutes = orderProviderRoutesByPolicy(deps.policyEngine, providerRoutes, ...);

// 4. ACO only if "wants dynamic Ollama routes"
if (wantsDynamicOllamaRoutes) {
  const ranked = await rankProviderRoutesWithAco({...});
  providerRoutes = ranked.orderedRoutes;
}

// 5. Execute with pheromone updates
await executeProviderRoutingPlan(..., providerRoutes, ...);
```

**The gap:** GLM models don't trigger `wantsDynamicOllamaRoutes`, so ACO never runs. Even if it did, zai/rotussy aren't dedicated Ollama routes, so they'd be in `passthroughRoutes`.

### 4. Pheromones Are Computed But Ignored

From `fallback/orchestrator.ts:buildFallbackCandidates()`:

```typescript
const sortedCandidates = [...allCandidates].sort((left, right) => {
  const idxLeft = providerIndex.get(left.providerId) ?? Number.MAX_SAFE_INTEGER;
  const idxRight = providerIndex.get(right.providerId) ?? Number.MAX_SAFE_INTEGER;

  // Only uses TTFT for tie-breaking within same provider order
  // Never consults pheromone store!
  
  return idxLeft - idxRight;
});
```

The orchestrator builds candidates in **providerRoutes order**, which comes from env. Pheromone store is passed to `executeProviderRoutingPlan` but only used for **post-hoc success/failure updates**, not candidate ordering.

---

## Root Causes

### RC-1: Two-Tier Routing Architecture

The system has **two separate routing mechanisms** that don't compose:

1. **Static fallback chain** (env-based) → used for all requests
2. **ACO ranking** (pheromone-based) → only for dedicated Ollama routes

They were designed for different purposes:
- Fallback chain: cross-provider failover when one provider exhausts keys
- ACO: choose among multiple Ollama nodes for load distribution

But GLM models need neither—they have a **canonical provider** (zai) that should be tried first, not mixed into a generic fallback chain.

### RC-2: No Model-Provider Capability Declaration

The system has no explicit mapping of "this model is best served by this provider." It learns via:
- Provider catalog (`/v1/models` discovery) → but catalogs lag new models
- Pheromone updates → but only after failures accumulate
- Special-case checks (`isGlmModel()`, `isVisionAutoModel()`) → scattered, not unified

**The missing concept:** A **model-provider capability registry** that declares:
- Which providers can serve which models
- Priority order per model family (not global fallback)
- Whether to use pheromones vs. static preference

### RC-3: Policy Engine Underutilized

The `policy/engine/` directory exists with:
- `provider-ordering.ts` → `orderProvidersByRule()` with preferred/excluded providers
- `strategy-selection.ts` → strategy choice per provider
- `account-ordering.ts` → account ordering within provider

But the **model routing rules** in policy config don't have a hook for pheromone-weighted ordering. Policy can say "prefer zai for GLM" but can't say "prefer the provider with highest pheromone for this model."

### RC-4: The Fallback Concept Itself

The `UPSTREAM_FALLBACK_PROVIDER_IDS` env var encodes a **bad assumption**: that any provider might be able to serve any model, so we should try them in order.

**Reality:**
- OpenAI OAuth accounts → only serve OpenAI models (need hardcoded paths)
- Z.ai → only serves GLM models
- Gemini → only serves Gemini models
- Ollama-cloud → serves open models, but model availability varies
- Vivgrid → serves subset of models

The "fallback" metaphor is wrong. We need **routing**, not **fallback**.

---

## Architectural Anti-Patterns

### AP-1: God File — `fallback/legacy.ts` (47KB, 1200+ lines)

Contains:
- Request execution loop
- Error classification
- Rate limit handling
- OAuth token refresh
- Image generation translation
- Pheromone updates
- Health tracking
- Federation fallback
- Bridge fallback

**Should be:** Orchestrator that delegates to specialized handlers.

### AP-2: Scattered Model Family Inference

Three implementations:
- `provider-routing.ts:looksLikeHostedOpenAiFamily()` → OpenAI only
- `fallback/legacy.ts:REQUESTY_MODEL_PREFIXES` → for Requesty routing
- `model-family.ts` (if it exists) → potentially different coverage

**Should be:** Single `ModelFamilyRegistry` with canonical mappings.

### AP-3: Route Handlers Duplicate Pipeline

`chat.ts`, `responses.ts`, `images.ts` each contain 80+ lines of identical routing orchestration.

**Should be:** Single `RoutingOrchestrator.execute()` called by all routes.

### AP-4: Pheromone Store Writes But Doesn't Read

`ProviderRoutePheromoneStore` is passed through the entire stack but only consulted in `rankProviderRoutesWithAco()` which most requests bypass.

**Should be:** Pheromone-weighted ordering in `buildFallbackCandidates()`.

---

## The Better Architecture

### Concept: Routing as Strategy Selection

Instead of "fallback chain," treat routing as **strategy selection**:

```typescript
interface RoutingStrategy {
  readonly name: string;
  
  // Which providers can serve this model?
  getCandidates(model: string, catalog: ResolvedModelCatalog): ProviderRoute[];
  
  // How to order candidates?
  orderCandidates(candidates: ProviderRoute[], context: RoutingContext): ProviderRoute[];
  
  // Should we try another candidate on failure?
  shouldFallback(outcome: AttemptOutcome): boolean;
}
```

### Strategy Implementations

1. **CanonicalProviderStrategy** — for models with a known best provider
   - GLM → zai (with rotussy as backup)
   - Gemini → gemini provider
   - OpenAI models → openai provider (OAuth accounts)
   
2. **DynamicOllamaStrategy** — for open models
   - Uses ACO to choose among Ollama nodes
   - Pheromone-weighted ordering
   - Health-aware candidate selection
   
3. **CatalogDiscoveryStrategy** — for unknown models
   - Query provider catalogs
   - Use pheromones to prefer historically successful providers
   - Learn from outcomes

4. **AutoModelStrategy** — for `auto:*` pseudo-models
   - Current cephalon/vision auto-selection logic
   - Compose with other strategies for final routing

### The Routing Orchestrator

```typescript
class RoutingOrchestrator {
  constructor(
    private readonly strategies: Map<string, RoutingStrategy>,
    private readonly policyEngine: PolicyEngine,
    private readonly pheromoneStore: ProviderRoutePheromoneStore,
    private readonly healthStore: AccountHealthStore,
    private readonly executor: RequestExecutor,
  ) {}
  
  async route(request: RoutingRequest): Promise<RoutingOutcome> {
    // 1. Resolve model
    const model = this.resolveModel(request);
    
    // 2. Select strategy
    const strategy = this.selectStrategy(model, request);
    
    // 3. Get candidates
    let candidates = strategy.getCandidates(model, request.catalog);
    
    // 4. Apply policy filters
    candidates = this.policyEngine.filterCandidates(candidates, model);
    
    // 5. Order by pheromones + health
    candidates = this.orderByLearnedBehavior(candidates, model);
    
    // 6. Execute
    for (const candidate of candidates) {
      const outcome = await this.executor.try(candidate, request);
      if (outcome.success) {
        await this.recordSuccess(candidate, model, outcome);
        return outcome;
      }
      await this.recordFailure(candidate, model, outcome);
      if (!strategy.shouldFallback(outcome)) break;
    }
    
    return this.handleExhausted(candidates, request);
  }
  
  private orderByLearnedBehavior(
    candidates: ProviderRoute[], 
    model: string
  ): ProviderRoute[] {
    return candidates.sort((a, b) => {
      const pheromoneA = this.pheromoneStore.getPheromone(a.providerId, model);
      const pheromoneB = this.pheromoneStore.getPheromone(b.providerId, model);
      const healthA = this.healthStore.getProviderHealth(a.providerId);
      const healthB = this.healthStore.getProviderHealth(b.providerId);
      
      // Combined score: 60% pheromone, 40% health
      const scoreA = 0.6 * pheromoneA + 0.4 * healthA;
      const scoreB = 0.6 * pheromoneB + 0.4 * healthB;
      
      return scoreB - scoreA; // Higher score first
    });
  }
}
```

### Model-Provider Capability Registry

```typescript
// In config or database
const MODEL_PROVIDER_PREFERENCES: Record<string, {
  readonly preferred: readonly string[];
  readonly allowed: readonly string[];
  readonly strategy: RoutingStrategyName;
}> = {
  "glm-*": {
    preferred: ["zai", "rotussy"],
    allowed: ["zai", "rotussy", "ollama-cloud"],
    strategy: "canonical",
  },
  "gpt-*": {
    preferred: ["openai"],
    allowed: ["openai", "factory", "requesty"],
    strategy: "canonical",
  },
  "gemini-*": {
    preferred: ["gemini"],
    allowed: ["gemini"],
    strategy: "canonical",
  },
  "qwen*": {
    preferred: [],
    allowed: ["ollama-cloud", "vivgrid", "requesty"],
    strategy: "dynamic-ollama",
  },
};
```

---

## Migration Path

### Phase 1: Immediate Mitigation (1 SP)

1. Reorder `UPSTREAM_FALLBACK_PROVIDER_IDS` to put capable providers first:
   ```
   UPSTREAM_FALLBACK_PROVIDER_IDS=zai,rotussy,ollama-cloud,requesty
   ```

2. Add `isGlmModel()` check to force zai/rotussy routing before fallback chain.

### Phase 2: Pheromone-Aware Candidate Ordering (3 SP)

1. Modify `buildFallbackCandidates()` to use pheromone store for ordering:
   ```typescript
   const sortedCandidates = [...allCandidates].sort((left, right) => {
     const pheromoneLeft = deps.providerRoutePheromoneStore.getPheromone(left.providerId, context.routedModel);
     const pheromoneRight = deps.providerRoutePheromoneStore.getPheromone(right.providerId, context.routedModel);
     
     // High pheromone → earlier in list
     // Zero pheromone but many failures → deprioritize
     return pheromoneRight - pheromoneLeft;
   });
   ```

2. Add heuristic boost for providers with recent success on this model.

### Phase 3: Model-Provider Registry (5 SP)

1. Create `ModelProviderRegistry` class with explicit capability mappings.
2. Migrate `isGlmModel()`, `isVisionAutoModel()`, etc. to registry lookups.
3. Wire registry into `buildProviderRoutes()` for model-specific ordering.

### Phase 4: Strategy Pattern Extraction (8 SP)

1. Extract `RoutingOrchestrator` from `chat.ts`, `responses.ts`, `images.ts`.
2. Implement `CanonicalProviderStrategy`, `DynamicOllamaStrategy`, `AutoModelStrategy`.
3. Route handlers become thin delegates: `orchestrator.route(request)`.

### Phase 5: Deprecate Fallback Env (2 SP)

1. Mark `UPSTREAM_FALLBACK_PROVIDER_IDS` as deprecated.
2. Default behavior: use model-provider registry + pheromones.
3. Keep env for backwards compatibility but warn on startup.

---

## Principles for Future Development

1. **Routing is strategy selection, not fallback.** Different models have different optimal paths.

2. **Pheromones are learned policy.** They should influence candidate ordering, not just record outcomes.

3. **Capability over discovery.** Declare which providers serve which models; use discovery only for the unknown.

4. **Single source of truth for model families.** Consolidate `looksLikeHostedOpenAiFamily()`, `REQUESTY_MODEL_PREFIXES`, etc.

5. **Thin controllers.** Route handlers should delegate to orchestrators, not implement routing logic.

6. **Policy engine is the policy engine.** All routing rules should flow through policy config, not ad-hoc checks in route files.

---

## References

- `provider-route-aco.ts` — ACO implementation (only for dedicated Ollama)
- `provider-strategy/fallback/legacy.ts` — 47KB god file
- `fallback/orchestrator.ts` — Candidate building (no pheromone ordering)
- `provider-routing.ts` — Static fallback chain construction
- `routes/chat.ts` — Full routing pipeline duplicated per route
- `policy/engine/provider-ordering.ts` — Underutilized policy hooks
- `specs/drafts/aco-systems-design.md` — Original ACO design intent
- `specs/drafts/model-family-registry.md` — Proposed family registry
