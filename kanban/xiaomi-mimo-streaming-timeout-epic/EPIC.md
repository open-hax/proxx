---
uuid: "bb6bee41-cf4f-4f46-99e1-53d352c50f00"
title: "xAIoMi Mimo-v2.5-pro Silent Stream Truncation Epic"
status: incoming
priority: P2
labels: ["bug", "streaming", "rate-limiting", "xiaomi"]
created_at: "2026-06-08T20:30:00.000Z"
source: "kanban/xiaomi-mimo-streaming-timeout-epic/EPIC.md"
category: "bug"
---

> Source: `kanban/xiaomi-mimo-streaming-timeout-epic/EPIC.md`
> Migrated-to-kanban: `kanban/xiaomi-mimo-streaming-timeout-epic/EPIC.md`

# xAIoMi Mimo-v2.5-pro Silent Stream Truncation Epic

**Epic ID:** XIAOMI-STREAM-TRUNC-001
**Status:** Incoming
**Total Points:** 8
**Estimated Timeline:** 1 sprint

## Problem Statement

When using xiaomi/mimo-v2.5-pro via Proxx, streams sometimes stop silently without error. The client sees a clean EOF mid-generation. Dashboard shows duplicated 429s, then a successful 200 that takes 20-30s, but the stream never completes.

## Root Cause

The queue `attempt-timeout-ms` (30s) covers the **entire** `executeProviderRoutingPlan` call, including:
1. Time spent on failed candidates (429s taking ~2s each)
2. Time to find a working candidate
3. **Actual streaming time**

When xiaomi returns 429s on initial candidates, the subsequent successful stream starts with less time remaining in the 30s budget. A 31s generation gets truncated at 30s, but the client sees a clean stream termination because `streamEventStreamToClient` just calls `rawResponse.end()` on any abort.

## Evidence

```
8:28:13 PM xiaomi/Masussy-key mimo-v2.5-pro Standard 429 2133 ms
8:25:52 PM xiaomi/Masussy-key mimo-v2.5-pro Standard 429 2117 ms
8:28:42 PM xiaomi/Masussy-key mimo-v2.5-pro Standard 200 31188 ms  ← truncated mid-stream
8:26:09 PM xiaomi/Masussy-key mimo-v2.5-pro Standard 200 19034 ms  ← ok (no preceding 429s)
```

The 31s request only succeeds when no preceding 429s eat the timeout budget.

## Goals

1. Prevent silent stream truncation when queue timeout fires mid-stream
2. Ensure clients receive meaningful errors when streams fail
3. Make timeout budget account for routing retry overhead
4. Move provider-specific rate limit classification from TypeScript into declarative EDN policy

## Child Specs

| Spec | Points | Priority | Dependencies |
|------|--------|----------|--------------|
| [1.1 Scoped queue attempt-timeout for xiaomi/mimo-v2.5-pro](./01-bump-attempt-timeout.md) | 1 | High | None |
| [1.2 Streaming-aware queue timeout](./02-streaming-aware-timeout.md) | 2 | High | None |
| [1.3 Mid-stream SSE error event](./03-midstream-error-handling.md) | 2 | High | None |
| [1.4 Rate-limit classification in EDN policy](./04-rate-limit-policy-extraction.md) | 3 | P1 | None |

## Success Criteria

1. **No silent truncations** - Clients always get an error or complete stream, never clean EOF mid-generation
2. **429 retry overhead accounted** - Queue timeout budget covers candidate failover + full generation
3. **SSE error propagation** - Mid-stream aborts emit `data: [ERROR] ...` before closing
4. **Dashboard clarity** - Truncated streams show distinct error code, not just 200
5. **Policy-driven rate limits** - Provider-specific 429 classification lives in EDN, not TypeScript
6. **xiaomi immediate failover** - xiaomi 429s try the next key immediately, no wasted retries

## Rollback Strategy

- Each child spec is independently deliverable
- Timeout changes are config-only (EDN), easily revertible
- SSE error handling is additive, safe to disable
- No schema migrations required

## Open Questions

1. Should attempt-timeout scale dynamically with model-family known latencies?
2. Should we reset the timer when streaming starts, or add a separate `stream-timeout-ms`?
3. Should SSE error events follow a specific format for opencode clients to parse?
