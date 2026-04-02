# Sub-spec: Fix responsesRequestToChatRequest reasoning.effort mapping

**Epic:** `reasoning-equivalence-epic.md`
**SP:** 1
**Priority:** P0
**Status:** Draft

## Bug

`responsesRequestToChatRequest()` in `src/lib/responses-compat.ts:819` passes the `reasoning` object through verbatim to the chat completions payload:
```typescript
if (requestBody["reasoning"]) {
  chatRequestBody["reasoning"] = requestBody["reasoning"];
}
```

But the OpenAI chat completions format uses `reasoning_effort` as a top-level field, not `reasoning.effort`. When the converted request is sent to a provider expecting chat completions format, the reasoning effort may be ignored.

The inverse direction (`chatRequestToResponsesRequest()` at line 499-514) correctly maps `reasoning_effort` → `reasoning.effort`, but the reverse does not.

## Scope

1. Update `responsesRequestToChatRequest()` to extract `reasoning.effort` and set it as `reasoning_effort`:
```typescript
if (isRecord(requestBody["reasoning"])) {
  const reasoning = requestBody["reasoning"];
  chatRequestBody["reasoning"] = reasoning;
  if (typeof reasoning["effort"] === "string") {
    chatRequestBody["reasoning_effort"] = reasoning["effort"];
  }
  if (typeof reasoning["summary"] === "string") {
    chatRequestBody["reasoning_summary"] = reasoning["summary"];
  }
}
```

2. Keep the `reasoning` object pass-through for providers that accept it

3. Add unit test: converting a Responses request with `reasoning.effort: "high"` produces chat completions with `reasoning_effort: "high"`

## Files to modify

- `src/lib/responses-compat.ts` — `responsesRequestToChatRequest()`
- `src/tests/reasoning-request-mapping.test.ts` — new test file

## Verification

- `pnpm build` passes
- New unit test passes
- Existing proxy tests pass (162/162)
- Live request with `reasoning.effort: "medium"` via `/v1/responses` correctly propagates effort to chat-format upstream providers
