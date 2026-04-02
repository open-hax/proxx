# Spec: Data-plane route handler orchestrator

**Status:** Draft
**Story points:** 5
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Findings 3, 6, 7

## Problem

`chat.ts` (498 lines), `responses.ts` (434 lines), and `images.ts` (210 lines) each manually orchestrate 11-14 steps of the routing pipeline:

1. Tenant policy checks
2. Catalog fetch + disabled-model check + alias resolution
3. Auto-model candidate ranking
4. Provider route building + filtering + ordering
5. Dynamic Ollama route discovery
6. ACO ranking
7. Strategy selection + payload building
8. Execution via `executeProviderRoutingPlan`
9. Federated fallback
10. Bridge fallback
11. Error summary handling (80+ lines of copy-paste per file)

Steps 1-8 are structurally identical across all three files. Steps 9-10 differ only in the upstream path string. Step 11 is a copy-paste block with minor log-message wording differences.

Additional smell: `chat.ts` fetches the catalog twice per request (lines 81 and 241) because the two phases (alias resolution and routing) aren't coordinated.

## Scope

### Step 1: Extract `handleRoutingOutcome(reply, execution, availability, ...)` 

Create `src/lib/routing-outcome-handler.ts`:

```typescript
export interface RoutingOutcomeDeps {
  readonly keyPool: KeyPool;
  readonly config: ProxyConfig;
}

export async function handleRoutingOutcome(
  deps: RoutingOutcomeDeps,
  reply: FastifyReply,
  execution: ProviderFallbackExecutionResult,
  availability: ProviderAvailabilitySummary,
  providerRoutes: readonly ProviderRoute[],
  context: StrategyRequestContext,
): Promise<boolean>;
```

This absorbs the 80-line error-handling block (`candidateCount === 0`, `sawRateLimit`, `sawUpstreamServerError`, `sawModelNotFound`, ...) that's currently copy-pasted in each route handler.

Return `true` if a response was sent, `false` if the caller should continue.

### Step 2: Extract `resolveModelRouting(deps, request, requestBody)`

Create `src/lib/model-routing-pipeline.ts`:

```typescript
export interface ModelRoutingInput {
  readonly config: ProxyConfig;
  readonly providerCatalogStore: ProviderCatalogStore;
  readonly tenantSettings: ProxySettings;
  readonly requestedModelInput: string;
}

export interface ModelRoutingResult {
  readonly routingModelInput: string;
  readonly resolvedModelCatalog: ResolvedModelCatalog | null;
  readonly resolvedCatalogBundle: ResolvedCatalogWithPreferences | null;
  /** If non-empty, the request was rejected (reply already sent). */
  readonly rejection?: { statusCode: number; errorCode: string; message: string };
  /** Resolved alias, if any. */
  readonly aliasTarget?: string;
}
```

This absorbs:
- Tenant model-allowed check
- Catalog fetch (single call)
- Disabled-model check
- Alias resolution
- Concrete model ID resolution

### Step 3: Slim down route handlers

Each route handler becomes:

1. Parse body → call `resolveModelRouting`
2. If rejection, send error and return
3. Build strategy context → build provider routes
4. Filter/order routes
5. Execute → call `handleRoutingOutcome`
6. Federated/bridge fallback
7. If `handleRoutingOutcome` returned false and no fallback handled it, send generic 502

The error handling block (step 5) shrinks from 80 lines to 1 function call.

## Non-goals

- Changing the strategy engine internals
- Changing the fallback execution logic in `provider-strategy/fallback.ts`
- Unifying the data-plane and control-plane dependency types

## Verification

- `pnpm build` passes
- All existing proxy tests pass: `npx tsx --test src/tests/proxy.test.ts`
- `chat.ts` < 300 lines, `responses.ts` < 300 lines, `images.ts` < 150 lines
- No duplicate `sawRateLimit`/`sawUpstreamServerError` blocks in route files
- Catalog is fetched exactly once per request in each handler
