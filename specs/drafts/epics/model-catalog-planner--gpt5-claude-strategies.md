# Sub-spec: ModelStrategy interface + Gpt5 + Claude strategies

**Epic:** `model-catalog-planner-epic.md`
**SP:** 3
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--catalog-admission-gate.md` (3 SP)

## Scope

Define the `ModelStrategy` interface and implement the two highest-traffic strategies: `Gpt5Strategy` (OpenAI family) and `ClaudeStrategy` (Anthropic family). These handle the majority of production requests.

### New code

```typescript
// src/lib/models/ModelStrategy.ts

export interface ModelStrategy {
  /** Which model family this strategy handles. */
  readonly family: ModelFamily;

  /** Which providers from the catalog-admitted set can this strategy handle? */
  eligibleProviders(
    catalog: ModelCatalog,
    modelId: string,
  ): readonly string[];

  /** Rank eligible providers for this request. */
  rankProviders(
    providers: readonly string[],
    scorer: SuitabilityScorer,
    modelId: string,
  ): readonly string[];
}
```

```typescript
// src/lib/models/strategies/Gpt5Strategy.ts

export class Gpt5Strategy implements ModelStrategy {
  readonly family = "openai" as const;

  eligibleProviders(catalog, modelId): readonly string[] {
    // OpenAI always eligible for GPT models
    // Factory eligible if catalog confirms model
    // Requesty eligible if catalog confirms model
    // OpenRouter eligible ONLY if catalog confirms model (not by default)
  }

  rankProviders(providers, scorer, modelId): readonly string[] {
    // Default order: openai > factory > requesty > openrouter
    // Adjusted by suitability scores
  }
}
```

```typescript
// src/lib/models/strategies/ClaudeStrategy.ts

export class ClaudeStrategy implements ModelStrategy {
  readonly family = "anthropic" as const;

  eligibleProviders(catalog, modelId): readonly string[] {
    // Anthropic direct always eligible
    // Factory eligible if catalog confirms model
  }

  rankProviders(providers, scorer, modelId): readonly string[] {
    // Default order: anthropic > factory
    // Adjusted by suitability scores
  }
}
```

### Design decisions

- **OpenRouter is conditionally eligible, not default.** OpenRouter's model coverage is unpredictable. Only admit it when the catalog explicitly confirms the model is available. This prevents hammering OpenRouter with models it doesn't serve.
- **Factory gets catalog check for Claude.** Factory routes Anthropic models through its own gateway. Only eligible if Factory's catalog lists the specific Claude model.
- **Ranking uses scorer but has a default preference order.** If scorer returns neutral scores (cold start), the default order is a safe fallback. Scorer adjusts within that envelope.

### What this replaces

Currently, GPT model routing is handled by:
- `REQUESTY_MODEL_PREFIXES` in `fallback/legacy.ts` (prefix matching)
- `looksLikeHostedOpenAiFamily()` in `provider-routing.ts` (heuristic)
- `selectProviderStrategy()` in `provider-strategy.ts` and `contexts.ts` (strategy selection)

And Claude routing by:
- The same `REQUESTY_MODEL_PREFIXES` array mapping `claude-` → `anthropic`
- `MessagesProviderStrategy` and `FactoryMessagesProviderStrategy` in `strategies/standard.ts` and `strategies/factory.ts`

All of this is replaced by the two `ModelStrategy` implementations, which use catalog admission rather than prefix heuristics.

## Verification

- [ ] `src/lib/models/ModelStrategy.ts` interface created
- [ ] `src/lib/models/strategies/Gpt5Strategy.ts` implemented with eligible providers: `openai` (always), `factory` (catalog), `requesty` (catalog), `openrouter` (catalog only)
- [ ] `src/lib/models/strategies/ClaudeStrategy.ts` implemented with eligible providers: `anthropic` (always), `factory` (catalog)
- [ ] Unit test: `Gpt5Strategy.eligibleProviders()` returns correct set for `gpt-5.4`, `o3-pro`, `gpt-oss`
- [ ] Unit test: `ClaudeStrategy.eligibleProviders()` returns correct set for `claude-opus-4-6`, `claude-sonnet-4`
- [ ] Unit test: `OpenRouter` excluded from GPT eligible set when catalog doesn't confirm model
- [ ] `pnpm build` passes
