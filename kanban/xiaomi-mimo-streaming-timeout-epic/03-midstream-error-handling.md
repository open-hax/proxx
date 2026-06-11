---
uuid: "aa3dee44-1d90-4e01-800d-267397689658"
title: "Spec 1.3: Mid-stream SSE error event propagation"
status: incoming
priority: P2
labels: ["bug", "streaming", "sse", "error-handling"]
created_at: "2026-06-08T20:30:00.000Z"
source: "kanban/xiaomi-mimo-streaming-timeout-epic/03-midstream-error-handling.md"
category: "bug"
---

> Source: `kanban/xiaomi-mimo-streaming-timeout-epic/03-midstream-error-handling.md`
> Migrated-to-kanban: `kanban/xiaomi-mimo-streaming-timeout-epic/03-midstream-error-handling.md`

# Spec 1.3: Mid-stream SSE error event propagation

**Spec ID:** XIAOMI-STREAM-TRUNC-001-03
**Epic:** [xAIoMi Mimo-v2.5-pro Silent Stream Truncation](./EPIC.md)
**Points:** 2
**Priority:** High
**Dependencies:** None

## Objective

When a stream is aborted mid-flight (queue timeout, upstream drop, etc.), emit an SSE error event before closing the connection so clients know the stream failed rather than completed. Follow the existing codebase convention used by `gemini.ts` and `ollama.ts`.

## Current State

`src/lib/provider-strategy/base.ts:185-204`:

```typescript
while (!rawResponse.writableEnded) {
  const { done, value } = await bootstrap.reader.read();
  if (done) {
    break;  // ← upstream dropped or queue aborted, client sees clean EOF
  }
  if (value && value.byteLength > 0) {
    rawResponse.write(value);
  }
}
// finally block calls rawResponse.end() — no error indication
```

- `done=true` from reader: clean break, `rawResponse.end()`
- Client receives partial stream with no error indication

## Target State

Before `rawResponse.end()`, write a single SSE `data:` line containing an OpenAI-compatible error payload, then close.

### Correct SSE error format

Use the existing codebase convention (matches `gemini.ts`, `ollama.ts`, and `openAiError()`):

```
data: {"error": {"message": "Stream aborted: queue timeout exceeded", "type": "server_error", "code": "queue_timeout", "param": null}}

```

**Do NOT use `event: error`** — it creates a separate SSE event with empty data. All field lines between blank lines belong to a single event.

**Do NOT overload `[DONE]`** — it semantically means successful completion. OpenAI clients treat it as clean termination.

## Implementation Steps

1. **Add error event helper**:
   - Create `src/lib/sse/error-event.ts`
   - Function: `buildSseErrorEvent(errorCode, errorMessage, errorType?)`
   - Returns `data: {...}\n\n` bytes matching `openAiError()` shape

2. **Modify `streamEventStreamToClient`** (`src/lib/provider-strategy/base.ts`):
   - Track whether stream completed naturally or was interrupted
   - In `finally` block, if interrupted and response not ended:
     - Wrap error-event write in `try/catch`
     - Check `!rawResponse.destroyed && !rawResponse.writableEnded` before writing
     - Write SSE error event via helper
     - Then call `rawResponse.end()`

3. **Handle different abort reasons**:
   - Queue timeout: `code: "queue_timeout"`, `type: "server_error"`
   - Upstream drop: `code: "upstream_disconnect"`, `type: "server_error"`
   - Bootstrap failure: already handled upstream, but could add SSE error there too

4. **Add stream read timeout**:
   - Port `readStreamChunkWithTimeout` from `openai.ts` to `streamEventStreamToClient`
   - Prevents indefinite hangs when upstream socket stalls

5. **Client contract**:
   - Document SSE error event format in `docs/streaming-errors.md`
   - opencode clients should detect `data:` lines containing `"error"` key

6. **Test**:
   - Mock abort controller, verify SSE error event emitted
   - Mock upstream drop, verify `upstream_disconnect` code
   - Verify existing tests still pass (no extra events on normal completion)
   - Test write-after-end protection (`try/catch` + `destroyed` check)

## Acceptance Criteria

- [ ] Mid-stream aborts emit SSE error event before closing
- [ ] Error events use `data: {...}\n\n` format matching existing codebase convention
- [ ] Normal stream completion emits no error event
- [ ] Writes guarded by `try/catch` and `destroyed` check
- [ ] opencode client can parse and report error to user
- [ ] Dashboard shows distinct error indication for truncated streams

## Risk Assessment

**Risk Level:** Low-Medium

- Additive change, doesn't break existing behavior
- SSE format is standard, clients should handle unknown events gracefully
- Must ensure error event doesn't corrupt already-partial JSON stream
- Best-effort signal: if truncation occurs mid-event, client may see parse error before structured error

## Estimated Time

3-4 hours

## Verification

```typescript
// Test snippet
const mockReader = {
  read: async () => {
    await new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 100));
    return { done: true, value: undefined };
  },
  releaseLock: () => {},
};

// After streamEventStreamToClient completes,
// verify rawResponse received:
// `data: {"error":{"message":"...","type":"server_error","code":"...","param":null}}\n\n`
```
