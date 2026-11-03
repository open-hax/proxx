---
uuid: "2233eb91-8ab8-4db9-85d1-522533be58db"
title: "Spec 1.1: Scoped queue attempt-timeout for xiaomi/mimo-v2.5-pro"
status: incoming
priority: P2
labels: ["bug", "streaming", "config"]
created_at: "2026-06-08T20:30:00.000Z"
source: "kanban/xiaomi-mimo-streaming-timeout-epic/01-bump-attempt-timeout.md"
category: "bug"
---

> Source: `kanban/xiaomi-mimo-streaming-timeout-epic/01-bump-attempt-timeout.md`
> Migrated-to-kanban: `kanban/xiaomi-mimo-streaming-timeout-epic/01-bump-attempt-timeout.md`

# Spec 1.1: Scoped queue attempt-timeout for xiaomi/mimo-v2.5-pro

**Spec ID:** XIAOMI-STREAM-TRUNC-001-01
**Epic:** [xAIoMi Mimo-v2.5-pro Silent Stream Truncation](./EPIC.md)
**Points:** 1
**Priority:** High
**Dependencies:** None

## Objective

Increase the queue `attempt-timeout-ms` specifically for `xiaomi/mimo-v2.5-pro` chat requests to account for 429 retry overhead + long generation times, preventing silent stream truncation. Use a scoped queue instance override rather than a global template change.

## Current State

- `resources/policies/runtime/70-request-queue-templates.edn:7`:
  - `:queue/attempt-timeout-ms`: 30000 (30s)
  - `:queue/total-timeout-ms`: 120000 (120s)
- xiaomi/mimo-v2.5-pro observed behavior:
  - 429 responses take ~2100ms each
  - Successful generations take 19-31s
  - With 2x 429s + 1x stream = ~35s total → exceeds 30s budget
- The queue schema (`src/proxx/schema.cljs:408-416`) already supports `:match/family` on `:request-queue-instance` contracts
- `src/proxx/queue/policy.cljs:26-36` (`instance-matches?`) already matches `match-family` against `ctx.model-family`

## Target State

Add a scoped `:request-queue-instance` contract that overrides `:queue/attempt-timeout-ms` only for `:model-family/mimo-v2-5-pro` chat requests, leaving the global default at 30s.

## Implementation Steps

1. Edit `resources/policies/runtime/70-request-queue-templates.edn`
2. Add a new queue instance contract:
   ```edn
   {:contract/id :queue/mimo-v2-5-pro-chat
    :contract/kind :request-queue-instance
    :queue/template-id :queue/default
    :match/family :model-family/mimo-v2-5-pro
    :match/request-kind :chat
    :queue/attempt-timeout-ms 60000}
   ```
3. Verify `:queue/total-timeout-ms` on `:queue/default` remains 120000 (still > attempt-timeout)
4. Validate EDN syntax: `cljs.reader/read-string` + `schema/assert!`
5. Restart Proxx process (EDN is read at startup)
6. Verify via config API that the new instance resolves for xiaomi/mimo-v2.5-pro chat requests

## Rejected Alternative: Global Bump (Option A)

~~Bump `:queue/attempt-timeout-ms` on `:queue/default` from 30000 → 60000.~~ **Rejected** — this would affect all providers and all request kinds, unnecessarily increasing timeout exposure and halving effective throughput under congestion (concurrency-limit 8 × 60s = 8 min per slot vs 4 min at 30s).

## Acceptance Criteria

- [ ] New `:request-queue-instance` contract added for `:model-family/mimo-v2-5-pro` + `:chat`
- [ ] `:queue/attempt-timeout-ms` set to 60000 on the instance override
- [ ] Global `:queue/default` `attempt-timeout-ms` remains 30000
- [ ] `:queue/total-timeout-ms` > `attempt-timeout-ms` invariant preserved for all instances
- [ ] EDN passes schema validation (`pnpm build` or `schema/assert!`)
- [ ] 31s+ xiaomi streams with preceding 429s complete successfully
- [ ] Other model families continue to use default 30s attempt-timeout

## Risk Assessment

**Risk Level:** Very Low

- Pure config change, no code modifications
- Scoped to one model family, no global side effects
- EDN files read at startup, easily revertible
- No schema or API contract changes (uses existing schema fields)

## Estimated Time

15 minutes (config edit + validation + restart + verify)

## Verification

```bash
# Validate EDN
pnpm build  # triggers schema validation

# Check resolved queue policy for mimo-v2.5-pro
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  "http://localhost:8789/api/v1/config"

# Trigger a xiaomi request after 429 cooldown
# Verify 200 response completes without truncation
```
