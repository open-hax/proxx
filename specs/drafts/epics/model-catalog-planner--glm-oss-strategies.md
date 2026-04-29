# Sub-spec: GlmStrategy + OpenSourceModelStrategy

**Epic:** `model-catalog-planner-epic.md`
**SP:** 2
**Status:** Draft
**Priority:** P1
**Depends on:** `model-catalog-planner--gpt5-claude-strategies.md` (3 SP)

## Scope

Implement the two remaining model strategies: `GlmStrategy` (Zhipu/GLM family) and `OpenSourceModelStrategy` (catch-all for recognized open-source model families).

### New code

```typescript
// src/lib/models/strategies/GlmStrategy.ts

export class GlmStrategy implements ModelStrategy {
  readonly family = "zhipu" as const;

  eligibleProviders(catalog, modelId): readonly string[] {
    // ZAI always eligible for GLM models
    // Rotussy eligible if catalog confirms model
    // Ollama providers eligible ONLY if catalog confirms specific GLM model
  }

  rankProviders(providers, scorer, modelId): readonly string[] {
    // Default order: zai > rotussy > ollama
    // Adjusted by suitability scores
  }
}
```

```typescript
// src/lib/models/strategies/OpenSourceModelStrategy.ts

export class OpenSourceModelStrategy implements ModelStrategy {
  readonly family = "opensource" as const;

  /** Known OSS model name prefixes that this strategy handles. */
  private static readonly KNOWN_PREFIXES = [
    "qwen", "llama", "gemma", "deepseek-r1", "gpt-oss",
    "mistral", "codestral", "phi",
  ] as const;

  eligibleProviders(catalog, modelId): readonly string[] {
    // Any catalog-admitted provider that has this model
    // No default provider list — purely catalog-driven
  }

  rankProviders(providers, scorer, modelId): readonly string[] {
    // Pure suitability scoring — no default preference order
    // Falls back to preference overlay order on cold start
  }

  /** Check if a model ID matches known OSS prefixes. */
  static matchesModel(modelId: string): boolean;
}
```

### Design decisions

- **OpenSourceModelStrategy is the catch-all.** If no other strategy's `eligibleProviders()` returns results but the catalog admits providers, this strategy accepts any catalog-admitted provider. This prevents "new model family has no strategy" gaps.
- **GlmStrategy includes conditional Ollama eligibility.** Some Ollama federation peers host GLM models, but not all. Only admit Ollama providers when the catalog explicitly confirms the model.
- **OpenSourceModelStrategy has no default provider order.** Unlike the proprietary families (which have natural primary providers), OSS models are served by whichever provider has them. Ranking is purely scoring-driven.
- **`KNOWN_PREFIXES` is static and enumerable.** This allows `RoutingPlanner` to quickly determine which strategy to use without invoking every strategy's `eligibleProviders()`.

### What this replaces

Currently, GLM routing is handled by:
- `isGlmModel()` in `glm-compat.ts` (prefix matching)
- `ZaiChatCompletionsProviderStrategy` in `strategies/standard.ts` (ZAI-specific)

And OSS model routing by:
- Scattered prefix checks in `provider-routing.ts` and `fallback/legacy.ts`
- Various `ChatCompletionsProviderStrategy` instances per provider

All replaced by the two strategy implementations.

## Verification

- [ ] `src/lib/models/strategies/GlmStrategy.ts` implemented with eligible providers: `zai` (always), `rotussy` (catalog), ollama (catalog only)
- [ ] `src/lib/models/strategies/OpenSourceModelStrategy.ts` implemented as catalog-driven catch-all
- [ ] Unit test: `GlmStrategy.eligibleProviders()` returns correct set for `glm-4.7-flash`, `glm-z1`
- [ ] Unit test: `OpenSourceModelStrategy.eligibleProviders()` returns all catalog-admitted providers for `qwen3.5:397b`, `deepseek-r1`
- [ ] Unit test: `OpenSourceModelStrategy.matchesModel()` matches known prefixes and rejects `gpt-5.4`, `claude-sonnet-4`
- [ ] `pnpm build` passes
