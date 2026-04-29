# Sub-spec: RoutingPlanner

**Epic:** `model-catalog-planner-epic.md`
**SP:** 3
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--catalog-admission-gate.md` (3 SP), `model-catalog-planner--gpt5-claude-strategies.md` (3 SP), `model-catalog-planner--glm-oss-strategies.md` (2 SP), `model-catalog-planner--suitability-scorer.md` (2 SP)

## Scope

Create `RoutingPlanner` — the catalog-gated planning engine that replaces `buildFallbackCandidates()` and the fallback loop's provider iteration. The planner produces an ordered `RoutingPlan` that `AttemptExecutor` (sub-spec 7) executes.

### New code

```typescript
// src/lib/routing/RoutingPlanner.ts

export interface RoutingPlan {
  readonly steps: readonly RoutingStep[];
  readonly preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
  readonly emptyReason?: "no_catalog_entry" | "no_eligible_strategy" | "no_credentials";
}

export interface RoutingStep {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly accounts: readonly ProviderCredential[];
  readonly adapter: ProviderAdapter;
}

export interface RoutingRequest {
  readonly modelId: string;
  readonly tenantId?: string;
  readonly forcedProviderId?: string;
  readonly forcedAccountId?: string;
  readonly requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">;
}

export interface RoutingPlanner {
  plan(request: RoutingRequest): Promise<RoutingPlan>;
}
```

### Planning algorithm

```
plan(request):
  1. ADMIT
     admitted = ModelCatalog.providersForModel(modelId)
     if admitted is empty:
       return empty plan (reason: no_catalog_entry)

  2. STRATEGY SELECT
     family = ModelFamilyRegistry.inferFamily(modelId)
     strategy = lookup strategy for family
     if no strategy matches:
       strategy = OpenSourceModelStrategy  (catch-all)

  3. ELIGIBLE
     eligible = strategy.eligibleProviders(catalog, modelId)
     eligible = intersection(admitted, eligible)
     if eligible is empty:
       return empty plan (reason: no_eligible_strategy)

  4. CREDENTIAL RESOLVE
     for each eligible provider:
       accounts = keyPool.getRequestOrder(providerId)
       accounts = policyFilter(accounts, modelId)
       accounts = quotaFilter(accounts)
       accounts = latencyReorder(accounts, modelId)
       if forcedProviderId/forcedAccountId: apply forced selection
     if no provider has remaining accounts:
       return empty plan (reason: no_credentials)

  5. SCORE AND RANK
     ranked = strategy.rankProviders(eligible, scorer, modelId)
     steps = ranked.map(provider => { providerId, baseUrl, accounts, adapter })
     preferredAffinity = resolve from PromptAffinityStore

     return RoutingPlan { steps, preferredAffinity }
```

### Empty plan handling

An empty plan is **not an error to retry**. It means the system correctly determined that no provider can serve the model. The caller (route handler) should return a structured 404/422 to the client.

This is the fundamental improvement over the current fallback loop, which would hammer all providers on a model none of them serve.

### What this replaces

- `buildFallbackCandidates()` in `fallback/orchestrator.ts` (132 lines) — candidate building
- The provider iteration loop in `fallback/legacy.ts` — which iterates all providers regardless of catalog admission
- `providerAccountsForRequest()` / `providerAccountsForRequestWithPolicy()` in `fallback/credential-selector.ts` — absorbed into step 4
- `reorderAccountsForLatency()` in `fallback/credential-selector.ts` — absorbed into step 4

The credential-selector functions are **absorbed**, not deleted — their logic moves into the planner's step 4.

### Compatibility

During migration, `buildFallbackCandidates()` remains the active path. `RoutingPlanner` is wired in parallel with a feature flag:

```typescript
const plan = config.useRoutingPlanner
  ? await routingPlanner.plan(request)
  : convertCandidatesToPlan(await buildFallbackCandidates(deps));
```

This allows A/B testing the planner against the existing fallback path.

## Verification

- [ ] `src/lib/routing/RoutingPlanner.ts` created with `plan()` implementing 5-step algorithm
- [ ] Integration test: known model with catalog entries → non-empty plan with expected provider order
- [ ] Integration test: unknown model with no catalog entries → empty plan (reason: no_catalog_entry)
- [ ] Integration test: model with catalog entries but no eligible strategy → empty plan (reason: no_eligible_strategy)
- [ ] Integration test: eligible providers but no valid credentials → empty plan (reason: no_credentials)
- [ ] Integration test: forced provider selection respects forcedProviderId/forcedAccountId
- [ ] `pnpm build` passes
