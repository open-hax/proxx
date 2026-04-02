# Sub-spec: Add true streaming to non-OpenAI Responses strategy

**Epic:** `reasoning-equivalence-epic.md`
**SP:** 5
**Priority:** P1
**Status:** Draft
**Depends on:** `reasoning-equivalence--stream-payload-check.md`

## Bug

`ResponsesProviderStrategy` in `src/lib/provider-strategy/strategies/standard.ts:90` always buffers the entire upstream response and then calls `writeInterleavedResponsesSse()` or `chatCompletionToSse()` for streaming clients. It never uses the true streaming path (`streamResponsesSseToChatCompletionChunks()`).

Meanwhile, `OpenAiResponsesProviderStrategy` (openai.ts:48) DOES use true streaming via `streamResponsesSseToChatCompletionChunks()`.

**Impact:** Non-OpenAI Responses providers never deliver incremental reasoning deltas to streaming clients. All reasoning arrives at once after the full response is buffered.

## Scope

1. Refactor `ResponsesProviderStrategy.handleProviderAttempt()` to detect SSE upstream responses and use `streamResponsesSseToChatCompletionChunks()`:
```typescript
if (responseLooksLikeEventStream(upstreamResponse, "responses_passthrough")) {
  // True streaming path
  const reader = upstreamResponse.body?.getReader();
  if (reader) {
    const stream = streamResponsesSseToChatCompletionChunks(reader, context.routedModel);
    // Pipe to reply as SSE
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    reply.raw.writeHead(upstreamResponse.status);
    for await (const chunk of stream) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
    return { kind: "handled" };
  }
}
// Fallback: existing buffered path for non-SSE responses
```

2. Ensure the streaming path handles:
   - `response.reasoning.delta` → `delta.reasoning_content`
   - `response.reasoning_text.delta` → `delta.reasoning_content`
   - `response.output_text.delta` → `delta.content`
   - `response.completed` → final chunk with `finish_reason: "stop"`
   - Usage token accumulation

3. Add integration test: non-OpenAI Responses provider streams reasoning deltas incrementally

## Files to modify

- `src/lib/provider-strategy/strategies/standard.ts` — `ResponsesProviderStrategy.handleProviderAttempt()`

## Verification

- `pnpm build` passes
- Existing proxy tests pass (162/162)
- Streaming Responses API request shows incremental `reasoning_content` deltas
