---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-fallback-extraction-early-return-strategy-md"
title: "Sub-spec: Early return refactor + strategy delegation"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.186Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--early-return-strategy.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--early-return-strategy.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/fallback-extraction--early-return-strategy.md`

# Sub-spec: Early return refactor + strategy delegation

**Epic:** `fallback-extraction-epic.md`
**SP:** 3
**Status:** ✅ Done (candidate builder extraction + FallbackDeps)
**Priority:** P0
**Depends on:** `fallback-extraction--response-handler-orchestrator.md` ✅

## Scope
Refactor the deeply nested conditionals in `executeProviderFallback` into early-return patterns, and move provider-specific error handling into strategy implementations.

### Changes

1. **Replace `executeProviderFallback` body** with a call to `executeFallbackOrchestrator`:
```typescript
// src/lib/provider-strategy/fallback.ts
export async function executeProviderRoutingPlan(
  strategy, reply, requestLogStore, ...
): Promise<ProviderFallbackExecutionResult> {
  return executeFallbackOrchestrator({
    strategy,
    context,
    candidates,
    credentialSelector: selectAndOrderCredentials,
    errorClassifier: classifyErrorResponse,
    responseHandler: handleSuccessfulResponse,
    keyPool, healthStore, eventStore, ...
  }, reply);
}
```

2. **Add optional error classification to ProviderStrategy interface** (backward compat):
```typescript
interface ProviderStrategy {
  // existing methods...
  classifyError?(response: Response, context: StrategyRequestContext): ErrorClassification | undefined;
}
```

This lets Factory/Gemini/Ollama strategies override error classification without modifying the shared classifier.

3. **Flatten nested conditionals** in orchestrator:
- Replace `if (response.ok) { if (isStream) { if (needsReasoning) { ... } } }` 
- With early-return: `if (!response.ok) return handleErrorResponse(...)`

### Tests
- All existing proxy tests pass unchanged
- Verify orchestrator produces identical output to legacy `executeProviderFallback` for same inputs
- Performance benchmark: orchestrator should not add measurable latency

## Verification
- `pnpm build` passes
- All existing tests pass
- `fallback.ts` main function <200 lines
- Cognitive complexity <100 (measured via eslint or cognitive-complexity tool)
