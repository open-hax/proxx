# Sub-spec: Fix streamPayloadHasReasoningTrace for Responses API deltas

**Epic:** `reasoning-equivalence-epic.md`
**SP:** 2
**Priority:** P0
**Status:** Draft

## Bug

`streamPayloadHasReasoningTrace()` in `src/lib/provider-utils.ts:99` only checks for chat completions format (`choices[].delta.reasoning_content`) via `chatCompletionHasReasoningContent()`. It does NOT check for Responses API delta types like `response.reasoning.delta`, `response.reasoning_text.delta`, etc.

Meanwhile, `streamPayloadHasSubstantiveChunks()` (same file, line 116) DOES check these types.

**Impact:** When a Responses-format SSE stream contains reasoning deltas but no chat-format `reasoning_content`, `streamPayloadHasReasoningTrace()` returns `false`. This triggers the skip-to-next-candidate logic in `BaseProviderStrategy.handleSuccessfulProviderAttempt()` (line 285), causing the proxy to abandon a valid reasoning response.

## Scope

1. Add Responses API reasoning delta detection to `streamPayloadHasReasoningTrace()`:
```typescript
// After the existing chatCompletionHasReasoningContent check:
const type = asString(parsed["type"]);
if (
  type === "response.reasoning.delta"
  || type === "response.reasoning_text.delta"
  || type === "response.reasoning_summary.delta"
  || type === "response.reasoning_summary_text.delta"
  || type === "response.reasoning_summary_part.delta"
) {
  const delta = parsed["delta"];
  if (typeof delta === "string" && delta.length > 0) return true;
  if (isRecord(delta) && typeof delta["text"] === "string" && delta["text"].length > 0) return true;
}
```

2. Also check for `response.output_item.added` with type `"reasoning"` (non-streaming responses that were converted to SSE)

3. Add unit tests:
   - `streamPayloadHasReasoningTrace` returns true for `response.reasoning.delta` events
   - `streamPayloadHasReasoningTrace` returns true for chat completions `reasoning_content` (existing behavior)
   - `streamPayloadHasReasoningTrace` returns false for empty streams
   - `streamPayloadHasReasoningTrace` returns false for streams with only `response.output_text.delta` (no reasoning)

## Files to modify

- `src/lib/provider-utils.ts` — `streamPayloadHasReasoningTrace()`
- `src/tests/reasoning-stream-check.test.ts` — new test file

## Verification

- `pnpm build` passes
- New unit tests pass
- Existing proxy tests pass (162/162)
- Live Responses API request with reasoning does NOT get skipped to next candidate
