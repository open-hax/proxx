# Sub-spec: Add true streaming to Anthropic Messages strategy

**Epic:** `reasoning-equivalence-epic.md`
**SP:** 3
**Priority:** P1
**Status:** Draft
**Depends on:** `reasoning-equivalence--field-name-normalization.md`

## Bug

`MessagesProviderStrategy` in `src/lib/provider-strategy/strategies/standard.ts:37` does NOT override `handleProviderAttempt()`, so it inherits `TransformedJsonProviderStrategy.handleProviderAttempt()` which always buffers the full JSON response and calls `chatCompletionToSse()`.

If Anthropic returns a true SSE stream with `content_block_delta` events containing thinking blocks, they are NOT incrementally delivered. The entire response is buffered first.

**Impact:** Anthropic Messages clients never get incremental reasoning/thought tokens in streaming mode.

## Scope

1. Create an Anthropic SSE stream parser that converts to chat completions SSE chunks:
```typescript
function streamAnthropicSseToChatCompletionChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  routedModel: string,
): AsyncGenerator<string>;
```

2. The parser should handle:
   - `content_block_start` with `type: "thinking"` → `delta.reasoning_content`
   - `content_block_delta` with `type: "thinking"` → `delta.reasoning_content`
   - `content_block_delta` with `type: "text"` → `delta.content`
   - `message_delta` with `stop_reason` → `finish_reason`
   - `message_start` / `message_delta` usage tokens

3. Override `MessagesProviderStrategy.handleProviderAttempt()` to detect SSE upstream and use the new parser:
```typescript
if (responseLooksLikeEventStream(upstreamResponse, "messages")) {
  const reader = upstreamResponse.body?.getReader();
  if (reader) {
    // Pipe streaming Anthropic SSE → chat completions SSE
    reply.header("content-type", "text/event-stream");
    reply.raw.writeHead(upstreamResponse.status);
    for await (const chunk of streamAnthropicSseToChatCompletionChunks(reader, context.routedModel)) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
    return { kind: "handled" };
  }
}
// Fallback: existing buffered JSON path
```

4. Add unit tests for the Anthropic SSE parser:
   - thinking block deltas → reasoning_content
   - text block deltas → content
   - message stop → finish_reason

## Files to modify

- `src/lib/provider-strategy/strategies/standard.ts` — `MessagesProviderStrategy`
- `src/lib/messages-compat.ts` — add `streamAnthropicSseToChatCompletionChunks()`

## Verification

- `pnpm build` passes
- Existing proxy tests pass (162/162)
- Streaming Anthropic request shows incremental reasoning_content deltas
