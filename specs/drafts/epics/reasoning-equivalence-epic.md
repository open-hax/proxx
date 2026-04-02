# Reasoning Token Handling Equivalence

**Status:** Draft
**Epic SP:** 13 (broken into 5 sub-specs ≤5 SP each)
**Priority:** P0 (correctness bug — can cause routing failures)

## Problem

reasoning_content handling is NOT equivalent across endpoint types and strategies. The audit found:

1. `streamPayloadHasReasoningTrace()` only checks chat completions format, not Responses API delta types — causes false "skip to next candidate" when reasoning IS present in Responses format
2. `reasoning` vs `reasoning_content` field name fallback is inconsistently applied across compat layers
3. `responsesRequestToChatRequest()` doesn't normalize `reasoning.effort` to `reasoning_effort` for providers expecting chat format
4. Non-OpenAI Responses, Anthropic Messages, and Gemini strategies always buffer → synthetic SSE (no true streaming)
5. Websearch endpoint drops reasoning content from underlying model

## Current State

| Strategy | Non-stream | Streaming | True streaming? |
|----------|-----------|-----------|-----------------|
| Chat passthrough | Transparent | Transparent | ✅ |
| OpenAI Responses | ✅ | ✅ `streamResponsesSseToChatCompletionChunks` | ✅ |
| Ollama | ✅ | ✅ `streamOllamaNdjsonToChatCompletionSse` | ✅ |
| Non-OpenAI Responses | ✅ | ❌ Buffered → synthetic | ❌ |
| Anthropic Messages | ✅ | ❌ Buffered → synthetic | ❌ |
| Gemini | ✅ | ❌ Buffered → synthetic | ❌ |

## Sub-specs

| # | Sub-spec | SP | Priority | File |
|---|----------|----|----------|------|
| 1 | Fix `streamPayloadHasReasoningTrace` for Responses API deltas | 2 | P0 | `epics/reasoning-equivalence--stream-payload-check.md` |
| 2 | Normalize `reasoning` vs `reasoning_content` field names | 2 | P0 | `epics/reasoning-equivalence--field-name-normalization.md` |
| 3 | Fix `responsesRequestToChatRequest` reasoning.effort mapping | 1 | P0 | `epics/reasoning-equivalence--request-effort-mapping.md` |
| 4 | Add true streaming to non-OpenAI Responses strategy | 5 | P1 | `epics/reasoning-equivalence--responses-true-streaming.md` |
| 5 | Add true streaming to Anthropic Messages strategy | 3 | P1 | `epics/reasoning-equivalence--messages-true-streaming.md` |

## Execution order

1 → 2 → 3 (all P0 correctness fixes, independent of each other)
4 → 5 (P1 enhancements, can parallelize)

## Definition of done

- `streamPayloadHasReasoningTrace()` returns true for Responses API reasoning deltas
- `reasoning_content` and `reasoning` fields are handled consistently everywhere
- `responsesRequestToChatRequest()` maps `reasoning.effort` to `reasoning_effort`
- Non-OpenAI Responses strategy uses `streamResponsesSseToChatCompletionChunks()` for streaming
- Anthropic Messages strategy parses SSE incrementally for thinking blocks
- All strategy variants deliver reasoning_content equivalently in both streaming and non-streaming
- Proxy test suite passes (162/162)
