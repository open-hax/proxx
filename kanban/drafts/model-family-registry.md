---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-model-family-registry-md"
title: "Spec: Unified model family registry"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.200Z"
source: "orgs/open-hax/proxx/specs/drafts/model-family-registry.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/model-family-registry.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/model-family-registry.md`

# Spec: Unified model family registry

**Status:** Draft
**Story points:** 3
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Finding 2
**Depends on:** `dead-code-model-routing-cleanup.md`

## Problem

Model family inference ("is this model OpenAI/Anthropic/Google/...?") is implemented in 3 places with different logic and coverage:

| File | Export | Used by |
|------|--------|---------|
| `provider-route-policies.ts` | `inferModelFamily()` | nothing (dead code) |
| `provider-strategy/fallback.ts:62` | `REQUESTY_MODEL_PREFIXES` | Requesty provider mapping |
| `provider-routing.ts:32` | `looksLikeHostedOpenAiFamily()` | Ollama exclusion, strategy selection |

The dead-code version and the fallback version have slightly different prefix lists and matching logic (e.g. `inferModelFamily` checks `"claude-"` while `REQUESTY_MODEL_PREFIXES` also checks `"claude-"` but maps to `"anthropic"` — same intent, different representation).

When a new model family appears (e.g. Mistral), all three must be updated independently.

## Scope

1. Create `src/lib/model-family.ts` with:
   - A `ModelFamily` type (`"openai" | "anthropic" | "google" | "zhipu" | "deepseek" | "moonshotai" | "qwen" | ...`)
   - A `MODEL_FAMILY_PREFIXES` constant: `ReadonlyArray<{ family: ModelFamily; prefixes: readonly string[] }>`
   - `function inferModelFamily(modelId: string): ModelFamily | undefined`
   - `const HOSTED_OPENAI_MODEL_FAMILIES: readonly ModelFamily[]` containing the exact families that should behave like hosted OpenAI for routing (`openai`, `zhipu`, `moonshotai`, and any other currently-supported OpenAI-compatible hosted families)
   - `function looksLikeHostedOpenAiFamily(modelId: string): boolean` (calls `inferModelFamily(modelId)` and returns `true` only when the result is in `HOSTED_OPENAI_MODEL_FAMILIES`)
   - `function modelFamilyProviderPreferences(family: ModelFamily): readonly string[]` (absorbs `MODEL_FAMILY_PROVIDER_PREFERENCES` from dead `provider-route-policies.ts` and `REQUESTY_MODEL_PREFIXES` from `fallback.ts`)

2. Update consumers:
   - `provider-strategy/fallback.ts`: replace `REQUESTY_MODEL_PREFIXES` + `requestyModelPrefix()` with imports from `model-family.ts`
   - `provider-routing.ts`: replace `looksLikeHostedOpenAiFamily` body with delegation to `model-family.ts`, re-export for backward compat

3. Delete dead `inferModelFamily` from `provider-route-policies.ts` (handled by cleanup spec if ordered after)

## Non-goals

- Changing the strategy engine's dispatch logic
- Adding new model families beyond what already exists

## Verification

- `pnpm build` passes
- `rg "inferModelFamily|REQUESTY_MODEL_PREFIXES" src/lib/` only shows `model-family.ts`
- `looksLikeHostedOpenAiFamily()` remains restricted to the explicit hosted-OpenAI allowlist rather than every recognized family
- Existing tests for `provider-routing.ts` and fallback pass
