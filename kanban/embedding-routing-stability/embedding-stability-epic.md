---
uuid: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
title: "Epic: Embedding backend stability + proxx load distribution"
status: incoming
priority: P1
labels: ["epic", "embeddings", "routing", "reliability"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/embedding-stability-epic.md"
category: "routing"
---

# Epic: Embedding backend stability + proxx load distribution

## Trigger

knoxx-backend spammed `openplanner is down ... POST /v1/search/vector ... This operation was aborted`.
Investigation showed **OpenPlanner, proxx, and Mongo were all healthy** — the outage was
purely the **embedding tier**, mislabeled as an OpenPlanner outage because the failure surfaced
as an aborted vector search.

## Failure chain (observed 2026-06-08)

knoxx → OpenPlanner `/v1/search/vector` → query embedding via proxx (`/v1/embeddings`,
`qwen3-embedding:0.6b`) → proxx tries embedding providers in strict order:

| Provider | Target | State | Symptom |
|---|---|---|---|
| `llamacpp-embed` | `http://llamacpp-embed:8081` | container **exited 3 days ago** | instant `fetch failed` |
| `ollama` | `http://ollama:11434` | container **not running** | instant `fetch failed` |
| `ollama-lan` | `http://192.168.12.68:11434` | box up, **embed runner wedged** | `/api/embed` hangs 30s+ |

With no provider returning, OpenPlanner's 30s embed timeout fired, the vector search hung,
and knoxx's 60s client `AbortError` mislogged it as "openplanner is down."

### ollama-lan wedge specifics
- `/api/tags`, `/api/show`, `/api/ps`, `/api/generate` all answered instantly (control plane fine)
- `/api/embed` and legacy `/api/embeddings` hung indefinitely (inference dead)
- `/api/ps` reported the model loaded with `size_vram: 0` and `expires_at` already in the past
- Diagnosis: keep-alive expired → ollama tried to unload the runner → GPU-backed runner
  wedged (hot GPU / driver instability) → stuck at `Stopping…` → all new embed requests
  queued behind a dead runner. Cleared only by restarting ollama on the LAN box.

## Two problems to fix

1. **Stability** — the load→expire→unload-wedge cycle on a hot GPU, plus the fact that
   `/api/tags`/`/api/ps` answer while inference is dead, so health checks didn't catch it.
2. **Distribution** — embeddings use strict ordered failover (`:provider-order/embeddings`),
   so all traffic piles on provider #1 and a dead-but-first provider wastes a round-trip on
   every request. proxx already has adaptive routing (`provider-route-aco.ts`,
   health/latency/recency weighting + `weightedRandomOrder`) but only at *account* selection,
   not provider-vs-provider for embeddings.

## Child tasks
- [ ] `3e607555` Stabilize ollama-lan embed runner (keep-alive resident + wedge watchdog)
- [ ] `fb515e6c` Revive llamacpp-stack as stable CPU embed primary
- [ ] `618f8638` Health-score embedding providers by real inference (control plane lies)
- [ ] `7c1fd7e6` Per-attempt embed timeout + fast failover (prereq for distribution)
- [ ] `dd2ab058` Provider-level load distribution for embeddings (ACO-at-route)
- [ ] `512e802d` Define embedding context size (num_ctx) through policy + fix oversized default

## Cross-repo follow-up (not proxx)
- knoxx should not surface an embedding-tier failure as "openplanner is down"; the
  `log-openplanner-down!` path in `clients/openplanner.cljs` over-attributes aborts.

## References
- `kanban/audits/2026-04-10-pheromone-routing-failure-analysis.md` (prior ACO routing audit)
- `resources/policies/runtime/20-provider-capabilities.edn` (`:provider-order/embeddings`, `:request-surface/embeddings`)
- `src/routes/embeddings.ts`, `src/lib/provider-routing.ts`, `src/lib/provider-route-aco.ts`
