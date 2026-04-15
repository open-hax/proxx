# Sub-spec: AttemptExecutor + route handler wiring

**Epic:** `model-catalog-planner-epic.md`
**SP:** 4
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--routing-planner.md` (3 SP), `model-catalog-planner--provider-adapters.md` (3 SP)

## Scope

Extract the execution loop from `legacy.ts` (1263 lines) into `AttemptExecutor`, create the shared `RoutingPipeline`, and wire it into all three route handlers. This is the highest-risk sub-spec because it replaces the active hot path.

### Part A: AttemptExecutor

```typescript
// src/lib/routing/AttemptExecutor.ts

export interface AttemptExecutor {
  /** Execute a routing plan: try steps in order until success or exhaustion. */
  execute(
    plan: RoutingPlan,
    context: ExecutionContext,
  ): Promise<ProviderFallbackExecutionResult>;
}

export interface ExecutionContext {
  readonly strategy: ModelStrategy;
  readonly clientHeaders: IncomingHttpHeaders;
  readonly requestBody: Record<string, unknown>;
  readonly reply: FastifyReply;
  readonly requestLogStore: RequestLogStore;
  readonly scorer: SuitabilityScorer;
  readonly config: ProxyConfig;
  readonly requestAuth?: ResolvedRequestAuth;
}
```

#### Execution semantics (extracted from `legacy.ts`)

1. Try steps in plan order.
2. For each step, try each account in step.accounts order.
3. **Transient error** (rate-limit 429, server 5xx):
   - Apply cooldown to the credential via error classifier.
   - Try next account in this step, or next step if accounts exhausted.
4. **Permanent error** (auth 401/403, model-not-found 404):
   - Record permanent disable for the credential.
   - Skip remaining accounts for this provider, advance to next step.
5. **Success**: record metrics (TTFT, TPS), return immediately.
6. **Exhausted plan**: return structured error summary with all attempt outcomes.

This preserves the exact retry/cooldown/permanent-disable semantics from `legacy.ts`, minus the "fallback" naming and the blind provider iteration (which is now `RoutingPlanner`'s job).

#### Key logic to preserve from `legacy.ts`

| Lines in `legacy.ts` | Logic | Where it goes |
|----------------------|-------|---------------|
| 137–300 | Main loop: iterate providers → iterate accounts | `AttemptExecutor.execute()` |
| 300–450 | Rate limit handling: cooldown, extract retry-after | `AttemptExecutor` + `error-classifier.ts` |
| 450–600 | SSE streaming setup and chunk handling | `AttemptExecutor` (via `ProviderAdapter.handleProviderResponse()`) |
| 600–750 | Error summarization: rate-limit/server-error/missing-model counts | `AttemptExecutor.execute()` return value |
| 750–900 | Affinity recording on success | `AttemptExecutor.execute()` → `PromptAffinityStore` |
| 900–1100 | Usage count extraction from SSE text | `AttemptExecutor` → `extractUsageCountsFromSseText()` |
| 1100–1263 | Compatibility re-exports and helper functions | Delete or move to focused modules |

### Part B: RoutingPipeline

```typescript
// src/lib/routing/RoutingPipeline.ts

export interface RoutingPipeline {
  /** Full routing pipeline: resolve → plan → execute → outcome. */
  handle(request: PipelineRequest): Promise<void>;
}

export interface PipelineRequest {
  readonly modelId: string;
  readonly requestBody: Record<string, unknown>;
  readonly clientHeaders: IncomingHttpHeaders;
  readonly reply: FastifyReply;
  readonly requestAuth?: ResolvedRequestAuth;
}
```

The pipeline composes:
1. `resolveModelRouting()` — from `routing-pipeline-extraction.md` (tenant check, alias, disabled check)
2. `RoutingPlanner.plan()` — catalog-gated planning
3. `AttemptExecutor.execute()` — ordered attempt execution
4. `handleRoutingOutcome()` — from `routing-pipeline-extraction.md` (error summary, response writing)

### Part C: Route handler slimming

Each handler becomes:

```typescript
// src/routes/chat.ts (target: <350 lines)
export async function handleChatCompletion(request, reply) {
  const pipeline = createPipeline(deps);
  await pipeline.handle({
    modelId: request.body.model,
    requestBody: request.body,
    clientHeaders: request.headers,
    reply,
    requestAuth: request.openHaxAuth,
  });
}
```

Current vs target:

| Handler | Current lines | Target lines | Reduction |
|---------|--------------|-------------|-----------|
| `chat.ts` | 400 | <350 | ~50+ lines |
| `responses.ts` | 325 | <300 | ~25+ lines |
| `images.ts` | 208 | <150 | ~58+ lines |

### Migration strategy

1. **Parallel run**: `RoutingPipeline` runs alongside existing routing. Feature flag controls which path is active.
2. **Shadow mode**: `RoutingPipeline` runs but its result is discarded; existing path serves the request. Compare outcomes for correctness.
3. **Cutover**: feature flag switches to `RoutingPipeline`. Existing path remains as fallback.
4. **Cleanup**: remove feature flag and old path (sub-spec 8).

## Verification

- [ ] `src/lib/routing/AttemptExecutor.ts` created with execution logic extracted from `legacy.ts`
- [ ] `src/lib/routing/RoutingPipeline.ts` created composing resolve → plan → execute → outcome
- [ ] `chat.ts` refactored to use `RoutingPipeline` (target: <350 lines)
- [ ] `responses.ts` refactored to use `RoutingPipeline` (target: <300 lines)
- [ ] `images.ts` refactored to use `RoutingPipeline` (target: <150 lines)
- [ ] All 162 proxy tests pass
- [ ] Catalog fetched exactly once per request (no double-fetch in chat.ts)
- [ ] `pnpm build` passes
