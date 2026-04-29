# Sub-spec: Provider adapter extraction

**Epic:** `model-catalog-planner-epic.md`
**SP:** 3
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--catalog-admission-gate.md` (3 SP)

## Scope

Extract a `ProviderAdapter` interface from the existing `ProviderStrategy` (from `shared.ts`) and create adapter instances that wrap existing strategy class logic. Adapters handle request/response translation only — no routing decisions.

### New interface

```typescript
// src/lib/providers/ProviderAdapter.ts

export interface ProviderAdapter {
  /** Which provider this adapter handles. */
  readonly providerId: string;

  /** Build the upstream request payload. */
  buildPayload(context: StrategyRequestContext): BuildPayloadResult;

  /** Apply provider-specific request headers. */
  applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void;

  /** Determine the upstream URL path. */
  getUpstreamPath(context: StrategyRequestContext): string;

  /** Handle the upstream response. */
  handleProviderResponse(response: Response, context: ProviderAttemptContext): Promise<ProviderAttemptOutcome>;
}
```

This is the existing `ProviderStrategy` interface (from `shared.ts`) with routing methods removed. The `matches()` method is gone — strategy selection is now `ModelStrategy`'s job.

### Adapter mapping from existing strategies

| Existing strategy class | Lines | New adapter | Notes |
|------------------------|-------|-------------|-------|
| `OpenAiChatCompletionsProviderStrategy` | 394 | `OpenAiAdapter` | Handles chat + responses passthrough |
| `OpenAiResponsesProviderStrategy` | (in openai.ts) | `OpenAiAdapter` | Same adapter, different upstream mode |
| `FactoryChatCompletionsProviderStrategy` | 373 | `FactoryAdapter` | Factory quirk handling |
| `FactoryMessagesProviderStrategy` | (in factory.ts) | `FactoryAdapter` | Same adapter, messages mode |
| `GeminiChatProviderStrategy` | 312 | `GeminiAdapter` | Gemini-specific payload/headers |
| `OllamaProviderStrategy` + `LocalOllamaProviderStrategy` | 167 + 105 | `OllamaAdapter` | Merged: local vs remote is a config flag |
| `ChatCompletionsProviderStrategy` + `MessagesProviderStrategy` + `ResponsesProviderStrategy` | 392 | `StandardAdapter` | Generic OpenAI-compatible providers |
| `OllamaCloudProviderStrategy` | 105 | absorbed into `OllamaAdapter` | Cloud variant config |
| `ZaiChatCompletionsProviderStrategy` | (in standard.ts) | absorbed into `StandardAdapter` | ZAI is OpenAI-compatible |

Result: **5 adapters** (`OpenAiAdapter`, `FactoryAdapter`, `GeminiAdapter`, `OllamaAdapter`, `StandardAdapter`) replacing 9+ strategy classes.

### Preserve error classifier

```typescript
// src/lib/providers/error-classifier.ts — moved from fallback/error-classifier.ts

export { PERMANENT_DISABLE_COOLDOWN_MS } from "./error-classifier.js";
export { shouldCooldownCredentialOnAuthFailure } from "./error-classifier.js";
export { shouldPermanentlyDisableCredential } from "./error-classifier.js";
export { shouldRetrySameCredentialForServerError } from "./error-classifier.js";
```

Error classification logic is provider-agnostic and used by `AttemptExecutor`. Move it to `providers/` as a shared utility.

### Compatibility shim

During migration, `ProviderStrategy` (from `shared.ts`) will be re-exported as a compatibility type alias for `ProviderAdapter`. This keeps existing consumers compiling while they're migrated to the new interface.

```typescript
// src/lib/provider-strategy/shared.ts (compatibility addition)

/** @deprecated Use ProviderAdapter from providers/ProviderAdapter.ts */
export type ProviderStrategy = ProviderAdapter;
```

## Verification

- [ ] `src/lib/providers/ProviderAdapter.ts` interface created
- [ ] `src/lib/providers/adapters/OpenAiAdapter.ts` wraps OpenAI strategy logic
- [ ] `src/lib/providers/adapters/FactoryAdapter.ts` wraps Factory strategy logic
- [ ] `src/lib/providers/adapters/GeminiAdapter.ts` wraps Gemini strategy logic
- [ ] `src/lib/providers/adapters/OllamaAdapter.ts` wraps Ollama strategy logic
- [ ] `src/lib/providers/adapters/StandardAdapter.ts` wraps generic OpenAI-compatible strategy logic
- [ ] `src/lib/providers/error-classifier.ts` moved from `fallback/error-classifier.ts`
- [ ] `ProviderStrategy` re-exported as deprecated type alias for `ProviderAdapter`
- [ ] All existing proxy tests pass unchanged
- [ ] `pnpm build` passes
