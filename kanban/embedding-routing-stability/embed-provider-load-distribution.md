---
uuid: "dd2ab058-5423-4c81-8f0a-8d6af6a02828"
title: "Provider-level load distribution for embeddings (ACO-at-route)"
status: incoming
priority: P2
labels: ["embeddings", "routing", "load-balancing", "aco"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/embed-provider-load-distribution.md"
category: "routing"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Provider-level load distribution for embeddings

Part of epic `22e8ce84`. Depends on `7c1fd7e6` (per-attempt timeout) and `618f8638` (inference health).

## Problem
Embeddings use strict ordered failover: `:provider-order/embeddings = ["llamacpp-embed" "ollama"
"ollama-lan"]` means "always try #1, fall to #2 only on failure." All traffic piles on the first
healthy provider; a dead-but-first provider wastes a round-trip every request. When multiple
embedding backends are available we want them *shared*, not stacked.

## Two approaches (recommend A)

### A. Reuse the ACO router at the provider-route level (recommended, adaptive)
proxx already scores by health (0.55) / latency (0.25) / recency (0.1) / confidence (0.1) and does
`weightedRandomOrder` — but only for **account** selection within a provider. Extend that scoring
to choose **among embedding provider-routes** so fast/healthy backends get proportionally more
traffic and a slow/wedged one automatically sheds load. Adaptive: reacts to a provider going slow
mid-flight, not just hard-down.

### B. Weighted / balanced preference-order kind (smaller, static)
Add a `:balanced` (or weighted) variant alongside `:preference-order` so `:provider-order/embeddings`
can express "split across these N healthy providers" with optional weights (e.g. CPU stack 30%,
GPU box 70%). Smaller policy-engine change, but static — won't react to live latency the way ACO does.

## Hard prerequisites (do not start before these land)
- `7c1fd7e6`: per-attempt timeout + fast failover — otherwise a hung provider stalls the whole
  request regardless of weighting.
- `618f8638`: inference-derived health — otherwise the weighter sends traffic to black-holing
  providers because their score stays neutral.

## Acceptance criteria
- With ≥2 healthy embedding providers, traffic is observably split (not 100% to one).
- A provider that degrades (rising latency / errors) receives proportionally less traffic without
  config changes.
- A hard-down provider is excluded from the rotation, not retried-first every request.

## References
- `src/lib/provider-route-aco.ts`, `src/lib/provider-route-pheromone-store.ts`
- `resources/policies/runtime/20-provider-capabilities.edn` (`:preference-order` semantics)
- `resources/policies/runtime/40-strategy-selection.edn`, `50-account-selection.edn`, `90-router.edn`
- `kanban/audits/2026-04-10-pheromone-routing-failure-analysis.md`
