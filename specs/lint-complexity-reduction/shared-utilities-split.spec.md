# Spec: shared.ts Utilities Split

## Problem Statement
`src/lib/provider-strategy/shared.ts` has:
- **Cognitive complexity: 55** (in `buildFactory4xxDiagnostics`)
- **File lines: 1643** (target: <500)
- **Exported items: 50+** (utilities, types, helpers)

The file is a grab-bag of provider-agnostic utilities with no clear domain boundaries.

## Root Causes

### 1. Mixed Domain Concerns
Functions span multiple domains:
- URL/path manipulation (`joinUrl`, `dedupePaths`)
- Credential/account management (`providerAccountsForRequest`, `reorderCandidatesForAffinity`)
- Usage tracking (`extractUsageCountsFromSseText`, `usageCountsForMode`)
- Request building (`buildPayloadResult`, `buildRequestBodyForUpstream`)
- Response parsing (`imageCountFromImagesPayload`, `imageCountFromResponsesPayload`)
- Factory diagnostics (`buildFactory4xxDiagnostics`)
- Fallback logic (`shouldRetrySameCredentialForServerError`, etc.)

### 2. Complex Diagnostic Function
`buildFactory4xxDiagnostics` (lines 595-700+) has:
- Multiple nested conditionals
- Deep object traversal
- Accumulator pattern with side effects

### 3. Type Definitions Intermingled
30+ exported types mixed with implementation:
```typescript
export type UpstreamMode = ...;
export interface ProviderAttemptContext { ... }
export interface BuildPayloadResult { ... }
// ... 27 more types
// Then 40+ functions
```

## Proposed Refactoring

### Phase 1: Domain Module Separation (target: file lines <800)

#### 1.1 Create Domain Modules
```
src/lib/provider-strategy/
├── shared.ts                    # Re-export public API only
├── shared/
│   ├── types.ts                  # All exported types
│   ├── url.ts                    # URL/path utilities
│   ├── credentials.ts            # Credential ordering/affinity
│   ├── usage.ts                  # Usage extraction/counting
│   ├── request.ts                # Request building
│   ├── response.ts               # Response parsing
│   ├── diagnostics.ts            # Factory diagnostics
│   ├── fallback.ts               # Fallback predicates
│   └── index.ts                  # Re-exports
```

#### 1.2 Extract Types
```typescript
// src/lib/provider-strategy/shared/types.ts
export type UpstreamMode = 
  | 'chat_completions'
  | 'responses'
  | 'responses_passthrough'
  | // ...
  
export interface ProviderAttemptContext {
  readonly providerId: string;
  // ...
}

export interface BuildPayloadResult {
  readonly upstreamPayload: Record<string, unknown>;
  // ...
}

// ... all other exported types
```

#### 1.3 Extract URL Utilities
```typescript
// src/lib/provider-strategy/shared/url.ts
export function joinUrl(baseUrl: string, path: string): string { ... }
export function dedupePaths(values: readonly string[]): string[] { ... }
```

### Phase 2: Simplify Diagnostics (target: complexity <30)

#### 2.1 Break Down `buildFactory4xxDiagnostics`
Current: ~130 lines, complexity 48, cognitive 55

```typescript
// src/lib/provider-strategy/shared/diagnostics.ts
export function buildFactory4xxDiagnostics(
  upstreamPayload: Record<string, unknown>,
  promptCacheKey?: string
): Factory4xxDiagnostics {
  const accumulator = createDiagnosticAccumulator();
  
  collectFromInstructions(accumulator, upstreamPayload);
  collectFromInput(accumulator, upstreamPayload);
  collectFromMessages(accumulator, upstreamPayload);
  
  return finalizeDiagnostics(accumulator);
}

function collectFromInstructions(
  acc: DiagnosticAccumulator,
  payload: Record<string, unknown>
): void {
  const instructions = asString(payload['instructions']);
  if (instructions) {
    acc.hasInstructions = true;
    acc.instructionsChars = instructions.length;
    addDiagnosticText(acc, instructions);
  }
}

function collectFromInput(
  acc: DiagnosticAccumulator,
  payload: Record<string, unknown>
): void {
  const input = payload['input'];
  if (!Array.isArray(input)) return;
  
  acc.requestFormat = 'responses';
  for (const item of input) {
    collectFromInputItem(acc, item);
  }
}

function collectFromMessages(
  acc: DiagnosticAccumulator,
  payload: Record<string, unknown>
): void {
  const messages = payload['messages'];
  if (!Array.isArray(messages)) return;
  
  acc.requestFormat = 'chat_completions';
  for (const message of messages) {
    collectFromMessage(acc, message);
  }
}
```

#### 2.2 Extract Helper Functions
```typescript
// src/lib/provider-strategy/shared/diagnostics-helpers.ts
export function createDiagnosticAccumulator(): DiagnosticAccumulator { ... }
export function addDiagnosticText(acc: DiagnosticAccumulator, text: unknown): void { ... }
export function collectDiagnosticContentText(acc: DiagnosticAccumulator, content: unknown): void { ... }
export function finalizeDiagnosticFingerprint(acc: DiagnosticAccumulator): string | undefined { ... }
```

### Phase 3: Usage Extraction (target: clean domain boundary)

```typescript
// src/lib/provider-strategy/shared/usage.ts
export type UsageCounts = {
  promptTokens?: number;
  completionTokens?: number;
  // ...
};

export function usageCountsFromCompletion(completion: Record<string, unknown>): UsageCounts { ... }
export function usageCountsFromUpstreamJson(json: unknown, model: string): UsageCounts { ... }
export function extractUsageCountsFromSseText(text: string, mode: UpstreamMode, model: string): UsageCounts { ... }
export function updateUsageCountsFromResponse(/* ... */): Promise<void> { ... }

// Image-specific
export function imageCountFromImagesPayload(payload: Record<string, unknown>): number | undefined { ... }
export function imageCountFromResponsesPayload(payload: Record<string, unknown>): number | undefined { ... }
```

## File Structure After Refactoring

```
src/lib/provider-strategy/
├── shared.ts                           # Public re-exports only (~50 lines)
└── shared/
    ├── index.ts                        # Re-export all from submodules
    ├── types.ts                         # All exported types (~100 lines)
    ├── url.ts                           # URL utilities (~30 lines)
    ├── credentials.ts                   # Credential ordering (~80 lines)
    ├── usage.ts                         # Usage extraction (~200 lines)
    ├── request.ts                       # Request building (~60 lines)
    ├── response.ts                      # Response parsing (~80 lines)
    ├── diagnostics.ts                   # Factory diagnostics (~100 lines)
    ├── diagnostics-helpers.ts           # Diagnostic helpers (~80 lines)
    ├── fallback.ts                      # Fallback predicates (~50 lines)
    └── constants.ts                     # PERMANENT_DISABLE_COOLDOWN_MS, etc.
```

## Migration Plan

### Step 1: Create Directory and Types (1 day)
- [ ] Create `src/lib/provider-strategy/shared/` directory
- [ ] Create `types.ts` with all exported interfaces and types
- [ ] Create `index.ts` that re-exports types
- [ ] Update `shared.ts` to import from `./shared/types.js`
- [ ] Verify builds

### Step 2: Extract Simple Domains (1 day)
- [ ] Extract `url.ts` (`joinUrl`, `dedupePaths`)
- [ ] Extract `constants.ts` (cooldown constants)
- [ ] Extract `credentials.ts` (`providerAccountsForRequest`, affinity functions)
- [ ] Update imports in consumers
- [ ] Verify tests

### Step 3: Extract Usage Domain (2 days)
- [ ] Create `usage.ts` with all usage-related functions
- [ ] Move `UsageCounts` type, extraction functions, update functions
- [ ] Update imports
- [ ] Add unit tests for each function

### Step 4: Extract Diagnostics (2 days)
- [ ] Create `diagnostics.ts` with main function
- [ ] Create `diagnostics-helpers.ts` with helpers
- [ ] Break down `buildFactory4xxDiagnostics` into sub-functions
- [ ] Add unit tests for diagnostic collection

### Step 5: Extract Remaining Domains (1 day)
- [ ] Extract `request.ts` (request building)
- [ ] Extract `response.ts` (response parsing)
- [ ] Extract `fallback.ts` (fallback predicates)
- [ ] Final cleanup of `shared.ts`

### Step 6: Update Public API (1 day)
- [ ] Replace `shared.ts` with re-exports from `./shared/index.js`
- [ ] Ensure backward compatibility for all imports
- [ ] Add deprecation notices for direct submodule imports
- [ ] Full test suite run

## Success Criteria

| Metric | Before | After Each Phase | Final Target |
|--------|--------|------------------|--------------|
| File lines (shared.ts) | 1643 | P1: 800, P2: 400, P3: 50 | <100 (re-exports) |
| `buildFactory4xxDiagnostics` complexity | 48 | P1: 30, P2: 15, P3: 10 | <10 |
| `buildFactory4xxDiagnostics` cognitive | 55 | P1: 30, P2: 15, P3: 10 | <10 |
| Domain modules | 0 | P1: 3, P2: 6, P3: 8 | 8+ |
| Average lines per file | 1643 | P1: 300, P2: 150, P3: 100 | <100 |

## Risk Mitigation

### Import Path Changes
Many files import from `shared.ts` directly.

**Mitigation:** Re-export everything from `shared.ts`:
```typescript
// shared.ts
export * from './shared/index.js';
// No breaking changes for importers
```

### Circular Dependencies
Domain modules may need types from each other.

**Mitigation:** Keep all types in `types.ts`, avoid cross-imports between implementation modules.

### Test Coverage
Existing tests import from `shared.ts`.

**Mitigation:** Tests continue working unchanged; new tests for domain modules added separately.

## Rollback Plan
- Each extraction is a separate PR
- Revert individual domain extractions without affecting others
- Maintain `shared.ts` as re-exporter throughout migration