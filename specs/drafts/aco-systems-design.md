# ACO Systems Design

## Status
Draft — design phase

## Overview
Two ant colony optimization systems: one for intelligent masscan scanning of Ollama hosts, one for smart provider routing.

Both share a core ACO engine: pheromone trails, heuristic scores, evaporation, and reinforcement.

---

## System 1: ACO-guided masscan block scanning

### Problem
Current masscan runs against `0.0.0.0/0` in one monolithic pass. This:
- takes hours/days at any reasonable rate
- can't be paused/resumed
- scans stale blocks as often as hot ones
- doesn't prioritize blocks that have historically yielded Ollama hosts

### Design

**Block decomposition:** Split IPv4 into /16 blocks (65,536 blocks × 65,536 IPs each). At 100k rate, each block takes ~65 seconds — well under the 5-minute budget.

**ACO state per block:**
```
block_cidr: str          # e.g., "81.70.0.0/16"
pheromone: float         # 0.0–1.0, decays over time
last_scan_at: datetime
last_yield: int          # hosts found in last scan
cumulative_yield: int    # total hosts found across all scans
scan_count: int
avg_scan_duration_ms: float
```

**Ant selection algorithm:**
```
score(block) = α × pheromone(block) + β × heuristic(block)

heuristic(block) = recency_weight × discovery_rate
  recency_weight = 1 / (1 + hours_since_last_scan)
  discovery_rate = cumulative_yield / (scan_count + 1)
```

**Pheromone update after each block scan:**
```
# Evaporation (all blocks)
pheromone *= (1 - ρ)  # ρ = 0.05 per cycle

# Reinforcement (scanned block only)
if yield > 0:
  pheromone += η × min(yield / 100, 1.0)  # η = 0.3
```

**Scheduler loop:**
```
while scanning:
  blocks = eligible_blocks(last_scan_older_than=1h)
  block = select_block_aco(blocks)
  result = run_masscan_block(block, rate=100000, timeout=300s)
  update_pheromone(block, result.yield)
  ingest_results(result)
  sleep(breathing_room)
```

**Configuration:**
- `ACO_BLOCK_SIZE`: default 16 (/16 blocks)
- `ACO_PHEROMONE_DECAY`: default 0.05
- `ACO_REINFORCEMENT`: default 0.3
- `ACO_ALPHA`: pheromone weight (default 0.6)
- `ACO_BETA`: heuristic weight (default 0.4)
- `ACO_MAX_BLOCK_DURATION_MS`: 300000 (5 minutes)
- `ACO_MIN_SCAN_INTERVAL_H`: 1 (don't re-scan within 1h)

---

## System 2: ACO-based smart provider routing

### Problem
Current routing cycles through providers in a fixed order. It doesn't learn from experience — a provider that's been fast/reliable/cheap doesn't get prioritized.

### Design

**Route prefix:** `smart:<model>` (like `auto:<model>`)
- e.g., `smart:gpt-4o` routes through ACO-selected provider
- `smart:gpt-oss:20b` routes through ACO-selected Ollama provider
- Falls back to auto ranking if no ACO data exists

**ACO state per provider-route:**
```
provider_id: str
model_pattern: str        # model or pattern this state applies to
pheromone: float          # 0.0–1.0, decays over time
request_count: int
success_count: int
total_latency_ms: float
total_tokens: int
total_cost_usd: float
last_used_at: datetime
health_score: float       # from account health store
suitability_score: float  # from provider catalog
```

**Ant walk (provider selection):**
```
candidates = providers_for_model(model)

for each candidate:
  heuristic = compute_heuristic(candidate, model)

  # Combine pheromone + heuristic
  score = α × pheromone(candidate, model)
        + β × heuristic

  # heuristic components:
  # - suitability (0-1): from provider catalog
  # - health (0-1): from account health store
  # - latency (0-1): inverse normalized avg latency
  # - cost (0-1): inverse normalized avg cost
  # - recency (0-1): prefer recently successful
  heuristic = w1 × suitability
            + w2 × health
            + w3 × (1 - normalized_latency)
            + w4 × (1 - normalized_cost)
            + w5 × recency_bonus

selected = softmax_select(candidates, scores)
```

**Pheromone update after request completes:**
```
# Evaporation (all routes for this model)
pheromone(provider, model) *= (1 - ρ)  # ρ = 0.02 per request

# Reinforcement
if success:
  quality = f(latency, tokens, cost)
  pheromone(provider, model) += η × quality
else:
  pheromone(provider, model) -= penalty

# quality = 0.5 × (1 - normalized_latency)
#         + 0.3 × normalized_tokens
#         + 0.2 × (1 - normalized_cost)
```

**Integration with existing routing:**
- New provider strategy: `SmartProviderStrategy`
- `matches`: when model starts with `smart:`
- `selectProvider`: runs ACO walk
- Result feeds into existing fallback chain
- Records outcome via `onRequestComplete` hook

**Integration with auto-model system:**
- `smart:auto:*` → ACO selection among auto-ranked models
- ACO can override the default ranking for specific model patterns

**Pheromone persistence:**
- Store in SQLite file (like prompt affinity) for fast reads
- Periodic flush to PostgreSQL for durability
- `ACO_PHEROMONE_FILE`: default `{data_dir}/provider-pheromones.json`

**Configuration:**
- `ACO_ROUTING_ALPHA`: pheromone weight (default 0.4)
- `ACO_ROUTING_BETA`: heuristic weight (default 0.6)
- `ACO_PHEROMONE_DECAY`: per-request decay (default 0.02)
- `ACO_REINFORCEMENT`: success bonus (default 0.15)
- `ACO_PENALTY`: failure penalty (default 0.3)
- Heuristic weights: suitability=0.3, health=0.25, latency=0.2, cost=0.15, recency=0.1

---

## Shared ACO engine

Both systems share a common `AntColony` class:

```python
class AntColony:
    def __init__(self, alpha, beta, decay, reinforcement, penalty):
        self.alpha = alpha
        self.beta = beta
        self.decay = decay
        self.reinforcement = reinforcement
        self.penalty = penalty
        self.pheromones: dict[str, float] = {}

    def select(self, candidates: list[str], heuristics: dict[str, float]) -> str:
        scores = {}
        for c in candidates:
            p = self.pheromones.get(c, 0.5)
            h = heuristics.get(c, 0.5)
            scores[c] = self.alpha * p + self.beta * h
        return softmax_select(scores)

    def reinforce(self, candidate: str, quality: float):
        self.pheromones[candidate] = min(1.0,
            self.pheromones.get(candidate, 0.5) + self.reinforcement * quality)

    def penalize(self, candidate: str):
        self.pheromones[candidate] = max(0.0,
            self.pheromones.get(candidate, 0.5) - self.penalty)

    def evaporate_all(self):
        for k in self.pheromones:
            self.pheromones[k] *= (1 - self.decay)
```

For TypeScript (proxx routing), equivalent implementation.

## Implementation order
1. ACO engine (Python) — shared class + tests
2. Masscan block scheduler — replaces monolithic scan
3. ACO engine (TypeScript) — port for proxx
4. Smart routing strategy — new strategy in proxx
5. `smart:*` prefix registration — wire into routing
