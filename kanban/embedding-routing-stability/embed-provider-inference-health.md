---
uuid: "618f8638-c7ff-4a41-ba6a-605266cc87b3"
title: "Health-score embedding providers by real inference (control plane lies)"
status: incoming
priority: P1
labels: ["embeddings", "routing", "health", "reliability"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/embed-provider-inference-health.md"
category: "routing"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Health-score embedding providers by real inference

Part of epic `22e8ce84`.

## Problem
The ollama-lan wedge was invisible to any control-plane health check: `/api/tags`, `/api/show`,
`/api/ps`, `/api/version` all answered instantly while `/api/embed` hung forever. A health signal
based on "does the provider respond" is worthless for embeddings — only an **actual embed** reveals
a wedged runner.

proxx's ACO router (`src/lib/provider-route-aco.ts`) already consumes a `healthScore`
(`DEFAULT_HEALTH_WEIGHT = 0.55`) per credential, but for embedding provider-routes there is no
inference-derived health input, so a black-holing provider keeps its default score and keeps
receiving traffic.

## Proposed changes
1. Feed embedding **request outcomes** (success / `fetch failed` / timeout/hang) into a per-route
   health + latency signal, keyed by `(providerId, baseUrl)`.
2. Optionally add an active probe: a tiny `/v1/embeddings` (or `/api/embed`) call on a short
   timeout that updates the health score; a hang must drive the score toward 0, not leave it neutral.
3. Surface the score so `dd2ab058`'s distribution can deprioritize/skip unhealthy routes
   *before* dispatch.

## Acceptance criteria
- A provider whose `/api/embed` hangs is scored unhealthy within N requests/probes and is
  skipped, without waiting the full per-request timeout each time.
- A recovered provider (after restart) is re-promoted automatically as success/latency recover.
- Health derives from embedding inference, never from `/api/tags`/`/api/ps`.

## References
- `src/lib/provider-route-aco.ts` (health/latency/recency/confidence weighting)
- `src/lib/provider-route-pheromone-store.ts`
- `src/routes/embeddings.ts` (per-attempt loop where outcomes are observed)
