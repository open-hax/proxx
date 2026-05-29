---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-fallback-extraction-response-handler-orchestrator-md"
title: "Sub-spec: Response handler + orchestrator extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.189Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--response-handler-orchestrator.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--response-handler-orchestrator.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/fallback-extraction--response-handler-orchestrator.md`

# Sub-spec: Response handler + orchestrator extraction

**Epic:** `fallback-extraction-epic.md`
**SP:** 3
**Status:** ✅ Done (types/foundation)
**Priority:** P0
**Depends on:** `fallback-extraction--credential-selector.md` ✅

## Scope
Extract the response handling (stream passthrough, JSON handling, error accumulation) and the main candidate loop into two new modules.

### New files

**`src/lib/provider-strategy/fallback/response-handler.ts`**:
```typescript
export interface ResponseHandlerContext {
  readonly strategy: ProviderStrategy;
  readonly reply: FastifyReply;
  readonly context: StrategyRequestContext;
  readonly payload: BuildPayloadResult;
}

export async function handleSuccessfulResponse(
  handlerContext: ResponseHandlerContext,
  upstreamResponse: Response,
): Promise<{ kind: "handled" } | { kind: "continue" }>;

export async function handleErrorResponse(
  handlerContext: ResponseHandlerContext,
  upstreamResponse: Response,
  classification: ErrorClassification,
): Promise<{ kind: "cooldown" | "disable" | "continue" }>;
```

**`src/lib/provider-strategy/fallback/orchestrator.ts`**:
```typescript
export interface OrchestratorDeps {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
  readonly candidates: ProviderCredential[];
  readonly credentialSelector: typeof selectAndOrderCredentials;
  readonly errorClassifier: typeof classifyErrorResponse;
  readonly responseHandler: typeof handleSuccessfulResponse;
  // + stores (keyPool, healthStore, eventStore, etc.)
}

export async function executeFallbackOrchestrator(
  deps: OrchestratorDeps,
  reply: FastifyReply,
): Promise<ProviderFallbackExecutionResult>;
```

### What moves
- The main `for (candidate of candidates)` loop → orchestrator.ts
- Stream passthrough logic → response-handler.ts
- JSON response handling → response-handler.ts
- Error accumulation (FallbackAccumulator updates) → orchestrator.ts
- Usage count extraction → response-handler.ts

### Tests
- Orchestrator test: mock credentials, verify fallback order
- Response handler test: mock upstream responses, verify stream/JSON/error paths
- Integration test: orchestrator + selector + classifier end-to-end

## Verification
- `pnpm build` passes
- New unit tests pass
- Existing proxy tests still pass (no behavior changes)
