---
uuid: "7c1fd7e6-5c23-4e30-ba1d-8f7a78d230af"
title: "Per-attempt embed timeout + fast failover (prereq for distribution)"
status: incoming
priority: P1
labels: ["embeddings", "routing", "timeout", "reliability"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/embed-per-attempt-timeout-failover.md"
category: "routing"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Per-attempt embed timeout + fast failover

Part of epic `22e8ce84`. **Prerequisite for `dd2ab058` (distribution).**

## Problem
When an embedding provider hangs (ollama-lan wedge), proxx does not bound the single attempt —
the request stalled for the full client timeout (observed 30–40s+) with no fall-through to the
next provider. A hung provider should be abandoned in ~1–3s and the next candidate tried, not
allowed to consume the whole request budget. Without this, even perfect weighting (`dd2ab058`)
will still stall on a wedged box.

Note the asymmetry observed: dead docker containers (`llamacpp-embed`, `ollama`) fast-fail with
`fetch failed` instantly, but a wedged-but-reachable provider (`ollama-lan`) hangs — so the timeout
must cover the *slow/hung* case, distinct from connection failures which already fall through fast.

## Proposed changes
1. Wrap each embedding provider attempt in an `AbortSignal.timeout(perAttemptMs)` (small, e.g.
   2–3s for the preflight `ensureNativeOllamaEmbedContextFits` and a separate bound for the embed
   call), independent of the overall request timeout.
2. On per-attempt timeout, classify as a failure → score the route down (`618f8638`) → advance to
   the next candidate immediately.
3. Make the preflight (`ensureNativeOllamaEmbedContextFits`) itself bounded — it currently appears
   to be where the ollama-lan path stalled (no provider-attempt log line emitted before the hang).

## Acceptance criteria
- A single wedged provider adds at most `perAttemptMs` to a request before failover, not the full
  request timeout.
- A request with one hung provider and one healthy provider succeeds in roughly
  `perAttemptMs + healthy latency`.
- Per-attempt timeout is configurable and defaulted conservatively.

## References
- `src/routes/embeddings.ts` (candidate loop, `ensureNativeOllamaEmbedContextFits` preflight)
- `src/lib/ollama-context.ts`
