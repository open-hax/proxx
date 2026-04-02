# Sub-spec: Normalize reasoning vs reasoning_content field names

**Epic:** `reasoning-equivalence-epic.md`
**SP:** 2
**Priority:** P0
**Status:** Draft

## Bug

The codebase uses both `reasoning_content` and `reasoning` as field names for reasoning tokens, with inconsistent fallback patterns:

- `chatMessageToResponsesOutput()` checks both `message["reasoning_content"]` and `message["reasoning"]` (responses-compat.ts:873)
- `responsesOutputToChatMessage()` checks `item["reasoning_content"]`, `item["reasoning"]`, AND content parts with type `"reasoning"`/`"thinking"` (responses-compat.ts:988-1013)
- `chatCompletionToSse()` checks `message["reasoning_content"]` OR `message["reasoning"]` (responses-compat.ts:1628)
- `chatCompletionHasReasoningContent()` only checks `choices[].delta.reasoning_content` — does NOT check `reasoning` (provider-utils.ts:185)
- `extractTerminalResponseFromEventStream()` may produce `reasoning` from some strategies and `reasoning_content` from others

**Impact:** If a provider returns reasoning under `message.reasoning` instead of `message.reasoning_content`, the reasoning detection (`chatCompletionHasReasoningContent`) fails, causing skip-to-next-candidate. Some code paths find it, others don't.

## Scope

1. Normalize to `reasoning_content` as the canonical field name everywhere in chat completions format
2. Add a `normalizeChatCompletionFields()` utility that ensures both `reasoning_content` and `reasoning` are set (for providers that check either)
3. Update `chatCompletionHasReasoningContent()` to check both field names:
```typescript
export function chatCompletionHasReasoningContent(completion: Record<string, unknown>): boolean {
  const choices = completion.choices;
  if (!Array.isArray(choices)) return false;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    const message = isRecord(choice.message) ? choice.message : undefined;
    const source = delta ?? message;
    if (!source) continue;
    if (typeof source["reasoning_content"] === "string" && source["reasoning_content"].length > 0) return true;
    if (typeof source["reasoning"] === "string" && source["reasoning"].length > 0) return true; // NEW
  }
  return false;
}
```

4. Audit all compat layers for inconsistent field name usage:
   - `responses-compat.ts` — ensure `chatMessageToResponsesOutput` and `responsesOutputToChatMessage` always handle both
   - `messages-compat.ts` — ensure `messagesToChatCompletion` uses `reasoning_content`
   - `ollama-compat.ts` — ensure `ollamaToChatCompletion` uses `reasoning_content`

5. Add unit tests for `chatCompletionHasReasoningContent` with both field names

## Files to modify

- `src/lib/provider-utils.ts` — `chatCompletionHasReasoningContent()`
- `src/lib/responses-compat.ts` — normalize field name usage
- `src/tests/reasoning-field-normalization.test.ts` — new test file

## Verification

- `pnpm build` passes
- `chatCompletionHasReasoningContent()` returns true for both `reasoning_content` and `reasoning`
- All compat layers produce `reasoning_content` as the canonical field
- Existing proxy tests pass (162/162)
