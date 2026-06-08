---
uuid: "512e802d-bfd3-44b9-9920-0d749591033e"
title: "Define embedding context size (num_ctx) through policy + fix oversized default"
status: incoming
priority: P1
labels: ["embeddings", "routing", "num_ctx", "policy", "reliability"]
created_at: "2026-06-08T00:53:30.000Z"
source: "kanban/embedding-routing-stability/embed-context-size-policy.md"
category: "routing"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Define embedding context size (num_ctx) through policy

Part of epic `22e8ce84`. Directly reduces the memory pressure behind the ollama-lan wedge (`3e607555`).

## Problem — proxx requests the full 32k context for tiny embeds

For a *normal* (non-overflow) embedding, proxx sends ollama the model's **entire** context window
as `num_ctx`, forcing a 32k-token KV cache allocation for a handful of input tokens. On a hot,
shared GPU box this is a major, pointless memory cost and a contributor to runner instability.

### Evidence
- LAN box loaded `qwen3-embedding:0.6b` at `context_length: 32768` (`/api/ps`, `/api/show`).
- OpenPlanner's embed inputs are tiny: chunk cap `EMBED_MAX_CHARS=6000` (~1500 tokens); search
  queries are a few tokens. OpenPlanner never requests a large context — proxx inflates it.
- proxx default ceiling `embedMaxContextTokens = 262144` (256k) — `src/lib/config.ts:530`
  (`EMBED_MAX_CONTEXT_TOKENS`). Effectively "no ceiling."

### Root cause (the bug)
`src/routes/embeddings.ts` computes `embedBudget` via `ensureNativeOllamaEmbedContextFits`
(`src/lib/ollama-context.ts`), which returns:
- `availableContextTokens = contextLength` (the full model context, **32768**)
- `recommendedNumCtx = min(contextLength, max(4096, roundUpToStep(inputTokens + 512)))`
  (correctly input-sized — e.g. ~4096 for small inputs)

But the dispatch only uses the recommended value in the overflow branch:
```js
const autoNumCtx = embedBudget && embedBudget.requiredContextTokens > embedBudget.availableContextTokens
  ? Math.min(maxContextTokens, embedBudget.recommendedNumCtx)
  : undefined;
// ...
nativeEmbedToOllamaRequest({ ...body, model }, autoNumCtx ?? embedBudget?.availableContextTokens)
```
In the common case `autoNumCtx` is `undefined`, so it passes `availableContextTokens` (**32768**),
and `nativeEmbedToOllamaRequest` (`src/lib/ollama-native.ts`) sets `options.num_ctx: 32768`.
The already-correct `recommendedNumCtx` is ignored on the happy path.

## Proposed changes

1. **Fix the default path:** size `num_ctx` to the input on every embed (use `recommendedNumCtx`,
   not `availableContextTokens`). The full-context fallback is wrong for embeddings.
2. **Make the ceiling policy-defined**, not a 256k env default:
   - Add an embedding context-size knob to policy (e.g. in `20-provider-capabilities.edn`),
     resolvable **per provider-route and/or per model-family** — so a constrained box
     (`ollama-lan`) can cap embeddings at, say, **8192**, while a roomy backend may allow more.
   - Resolve the **policy cap** in order: per-route cap → per-family cap → conservative global
     default (propose **8192**, replacing the 256k default).
   - A request-supplied `num_ctx` is a *desired* value, never an override of the cap. Always
     clamp it: `effective_ctx = min(requested_num_ctx ?? recommendedNumCtx, policy_cap)`. A
     request may shrink `num_ctx` but can never exceed the resolved cap — otherwise a client
     could bypass the very safeguard this task introduces. (Per CodeRabbit on #274.)
   - Keep the overflow guard: if input genuinely exceeds the cap, error clearly
     (`embed_context_overflow`) rather than silently ballooning the cache.
3. Plumb the resolved cap through `embeddings.ts` → `ensureNativeOllamaEmbedContextFits`
   (clamp `recommendedNumCtx`/`maxContextTokens` to it) → `nativeEmbedToOllamaRequest`.

## Acceptance criteria
- A small embedding request results in ollama loading/running at a small `num_ctx` (≤ policy cap,
  e.g. 4096–8192), verified via `/api/ps` `context_length` on the LAN box — **not 32768**.
- The cap is changeable in policy (EDN) per provider-route / model-family without a code change,
  and takes effect on restart.
- Inputs above the cap fail fast with a clear overflow error, not a silent 32k allocation.
- Default global embedding `num_ctx` ceiling is sane (≤ 8192), not 262144.

## References
- `src/routes/embeddings.ts` (autoNumCtx / availableContextTokens dispatch)
- `src/lib/ollama-context.ts` (`ensureNativeOllamaEmbedContextFits`, `recommendedNumCtx`)
- `src/lib/ollama-native.ts` (`nativeEmbedToOllamaRequest` → `options.num_ctx`)
- `src/lib/config.ts:530` (`embedMaxContextTokens` default 262144)
- `resources/policies/runtime/20-provider-capabilities.edn` (where the cap should live)
