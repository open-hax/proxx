# Spec: fallback.ts Extraction

## Problem Statement
`executeProviderFallback` in `src/lib/provider-strategy/fallback.ts` has:
- **Cyclomatic complexity: 154** (target: <50)
- **Cognitive complexity: 399** (target: <100)
- **Lines: 663** (target: <200)

## Root Causes

### 1. Multi-Responsibility Pattern
The function handles:
- Credential ordering and affinity
- Provider strategy execution
- Transient retry logic
- Rate limit cooldown
- Permanent disable handling  
- Error accumulation for diagnostics
- Usage tracking and logging
- Streaming passthrough
- Image generation special case
- Codex/Responses API translation

### 2. Deeply Nested Conditionals
```
for (candidate of candidates)
  for (attempt 0..maxRetries)
    if (response.ok)
      if (isEventStream)
        if (needsReasoningTrace)
          if (hasReasoning)
            ...
          else
            continue fallback
        else
          ...
      else
        ...
    else
      if (status >= 500)
        if (retrySame)
          ...
        else
          continue to next candidate
      else if (status === 401 || status === 403)
        if (status === 402 || status === 403)
          ...
        else
          ...
      ...
```

### 3. Inline Helper Logic
- `REQUESTY_MODEL_PREFIXES` routing
- Error classification
- Response stream handling
- Usage extraction

## Proposed Refactoring

### Phase 1: Extract Handlers (target: complexity <80)

#### 1.1 Create `FallbackOrchestrator` class
```typescript
// src/lib/provider-strategy/fallback/orchestrator.ts
export class FallbackOrchestrator {
  constructor(
    private readonly strategy: ProviderStrategy,
    private readonly context: FallbackContext,
    private readonly accumulator: FallbackAccumulator,
  ) {}

  async execute(): Promise<FallbackResult> {
    for (const candidate of this.context.candidates) {
      const result = await this.tryCandidate(candidate);
      if (result.handled) return result;
    }
    return this.buildFinalError();
  }

  private async tryCandidate(candidate: Candidate): Promise<FallbackResult> { ... }
}
```

#### 1.2 Extract `CredentialSelector`
```typescript
// src/lib/provider-strategy/fallback/credential-selector.ts
export class CredentialSelector {
  constructor(
    private readonly keyPool: KeyPoolInterface,
    private readonly promptAffinityStore?: PromptAffinityStore,
  ) {}

  async selectForProvider(
    providerId: string,
    config: SelectionConfig
  ): Promise<ProviderCredential[]> { ... }

  applyAffinity(
    candidates: ProviderCredential[],
    preferred?: PreferredAffinity
  ): ProviderCredential[] { ... }

  applyPolicyFilter(
    candidates: ProviderCredential[],
    policy?: PolicyEngine
  ): ProviderCredential[] { ... }
}
```

#### 1.3 Extract `ResponseHandler`
```typescript
// src/lib/provider-strategy/fallback/response-handler.ts
export class ResponseHandler {
  constructor(
    private readonly reply: FastifyReply,
    private readonly context: HandlerContext,
  ) {}

  async handleSuccess(response: Response): Promise<HandledResult> { ... }
  async handleError(response: Response): Promise<ContinueReason> { ... }
  async handleStream(response: Response): Promise<HandledResult> { ... }
}
```

#### 1.4 Extract `ErrorClassifier`
```typescript
// src/lib/provider-strategy/fallback/error-classifier.ts
export type ErrorClassification = 
  | 'transient'
  | 'rate_limit'
  | 'auth_failure'
  | 'permanent_disable'
  | 'model_not_found'
  | 'quota_exceeded'
  | 'bad_request';

export function classifyError(
  response: Response,
  providerId: string
): ErrorClassification { ... }

export function shouldRetrySame(
  classification: ErrorClassification
): boolean { ... }

export function getCooldownMs(
  classification: ErrorClassification,
  response: Response
): number | undefined { ... }
```

### Phase 2: Early Return Pattern (target: complexity <60)

Replace nested conditionals with early returns:

```typescript
// Before (nested)
if (response.ok) {
  if (isStream) {
    if (needsReasoning) {
      if (hasReasoning) {
        return handleStream();
      } else {
        continue fallback;
      }
    }
    return handleStream();
  }
  return handleJson();
}

// After (early returns)
if (!response.ok) {
  return this.handleErrorResponse(response);
}

const result = await this.strategy.handleProviderAttempt(reply, response, context);
if (result.kind === 'handled') {
  return { kind: 'handled' };
}
return { kind: 'continue', ...result };
```

### Phase 3: Strategy Delegation (target: complexity <50)

Move provider-specific logic into strategy implementations:

```typescript
// Strategy already has handleProviderAttempt
// Add error classification responsibility

interface ProviderStrategy {
  // ... existing methods
  
  classifyError(response: Response): ErrorClassification;
  shouldRetrySame(error: ErrorClassification): boolean;
  getCooldownDuration(error: ErrorClassification, response: Response): number | undefined;
}
```

## File Structure After Refactoring

```
src/lib/provider-strategy/fallback/
├── orchestrator.ts          # FallbackOrchestrator (~150 lines)
├── credential-selector.ts   # CredentialSelector (~120 lines)
├── response-handler.ts      # ResponseHandler (~200 lines)
├── error-classifier.ts      # ErrorClassification (~80 lines)
├── types.ts                 # FallbackResult, ContinueReason, etc.
└── index.ts                  # Public exports
```

## Migration Plan

### Step 1: Create directory and types (1 day)
- [ ] Create `src/lib/provider-strategy/fallback/` directory
- [ ] Extract `types.ts` with all shared interfaces
- [ ] Export from `index.ts`
- [ ] No behavior changes, only organizational

### Step 2: Extract ErrorClassifier (2 days)
- [ ] Create `error-classifier.ts`
- [ ] Move classification logic from `executeProviderFallback`
- [ ] Add unit tests for each classification path
- [ ] Wire into existing code via import

### Step 3: Extract CredentialSelector (2 days)
- [ ] Create `credential-selector.ts`
- [ ] Move `reorderCandidatesForAffinity`, `providerAccountsForRequest`, `providerAccountsForRequestWithPolicy`
- [ ] Add unit tests for ordering logic
- [ ] Wire into orchestrator

### Step 4: Extract ResponseHandler (3 days)
- [ ] Create `response-handler.ts`
- [ ] Move stream handling, json handling, error handling
- [ ] Add integration tests for each response type
- [ ] Wire into orchestrator

### Step 5: Create Orchestrator and integrate (2 days)
- [ ] Create `orchestrator.ts` with main loop
- [ ] Replace `executeProviderFallback` with orchestrator call
- [ ] End-to-end test all provider fallback paths
- [ ] Verify metrics unchanged

## Success Criteria

| Metric | Before | Phase 1 Target | Phase 2 Target | Final Target |
|--------|--------|---------------|-----------------|--------------|
| Cyclomatic Complexity | 154 | 80 | 60 | <50 |
| Cognitive Complexity | 399 | 150 | 100 | <50 |
| Lines (main function) | 663 | 300 | 200 | <150 |
| Test Coverage | existing | ≥90% | ≥90% | ≥90% |

## Rollback Plan
- Each phase is a separate PR
- Feature flag `FALLBACK_ORCHESTRATOR_V2` allows instant rollback
- Previous implementation preserved during migration
- Integration tests compare old vs new behavior