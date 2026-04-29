# Proxx Ledger Event Specification

This document defines the 11 canonical ledger events used by the Proxx routing
layer to derive session epochs, account affinity, and cache-recovery decisions.

All events are immutable once written.  Mutable state (account health, epoch,
cooldown) is derived by projection functions over the ledger — never by updating
existing records.

---

## Design Principles

- **Append-only.** Events are never updated or deleted.
- **Epoch = projection.** A session–account epoch is the hash of the most recent
  failure event for a `(session, provider, account, model)` tuple.  No counter is
  incremented; you scan the ledger.
- **Policy as data.** Cache TTLs, quota windows, and promotion thresholds live in
  `cache_policy.cljs` and `projector.cljs`, not in the event handlers.
- **Raw body preserved.** Silent-failure providers (e.g. Ollama returning 200 with
  a quota message in the body) have their `raw_body` retained so labels can be
  corrected or classifiers retrained without data loss.

---

## Epoch Semantics

An **epoch** for a `(session_id, provider_id, account_id, model_id)` tuple is:

```
epoch_id = hash(event_id | ts | event_type | outcome)
           of the most recent failure/abandonment event
```

If no failure has occurred, the epoch is the sentinel `::epoch-0`.

An **affinity binding** is valid as long as `stored_epoch_id == current_epoch(ledger, tuple)`.
When a new failure event is appended, the epoch shifts and old bindings become stale.

---

## Event Catalogue

### 1. `session_start`

First occurrence of a client providing a given harness cache key.

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | Client-visible session identity |
| `harness_id` | string | opencode / pi / etc. |
| `harness_cache_key` | string | What the client calls it |
| `derived_cache_key` | string | Internal key at epoch 0 |
| `provider_id` | string | Initial provider choice |
| `account_id` | string | Initial account choice |
| `model_id` | string | Initial model choice |

---

### 2. `empty_provider_response`

HTTP call returned an empty body, or a body that could not be decoded.  Covers
Ollama-style silent quota exhaustion (HTTP 200, quota message in body).

| Field | Type | Notes |
|---|---|---|
| `request_id` | string | |
| `http_status` | int | Often 200 for Ollama quota errors |
| `raw_body` | string? | Retained for re-labelling |
| `outcome` | RoutingOutcome | `:quota-exhausted-in-body`, `:empty-response`, etc. |
| `label` | string? | Classifier output |
| `label_confidence` | double? | 0..1 |

---

### 3. `unrecognized_response_schema`

Response body was non-empty but did not match any known provider schema.

| Field | Type | Notes |
|---|---|---|
| `request_id` | string | |
| `http_status` | int | |
| `raw_body` | string? | |
| `expected_schema` | keyword | `:openai-chat`, `:anthropic-messages`, etc. |

---

### 4. `session_account_changed`

Router switched accounts for an ongoing session.

| Field | Type | Notes |
|---|---|---|
| `from_account_id` | string | |
| `to_account_id` | string | |
| `from_provider_id` | string? | |
| `to_provider_id` | string? | |
| `reason` | RoutingOutcome | Why we left the old account |
| `epoch_id_before` | string | Epoch at time of switch |
| `epoch_id_after` | string | New epoch |

---

### 5. `session_model_changed`

Router or client changed the model mid-session.

| Field | Type | Notes |
|---|---|---|
| `from_model_id` | string | |
| `to_model_id` | string | |
| `reason` | enum | `:context-overflow`, `:policy`, `:manual`, `:client-requested` |
| `epoch_id_before` | string | |
| `epoch_id_after` | string | |

---

### 6. `session_churn_detected`

Client-side message pruning or compaction changed the session message array in
a way that may break prompt cache affinity.

| Field | Type | Notes |
|---|---|---|
| `churn_type` | enum | `:tool-call-pruning`, `:compaction`, `:client-unknown` |
| `prefix_similarity_before` | double? | 0..1 cosine or length ratio |
| `prefix_similarity_after` | double? | |
| `message_count_before` | int? | |
| `message_count_after` | int? | |

---

### 7. `context_overflow_detected`

Practical context limit reached for `(provider, model)`.  May differ from the
advertised limit — e.g. z.ai emits truncation signals well before the published
context window.

| Field | Type | Notes |
|---|---|---|
| `tokens_in` | int | |
| `tokens_out` | int? | |
| `advertised_context_limit` | int? | From provider catalog |
| `observed_limit_estimate` | int? | Derived from this event |
| `overflow_signal` | enum | `:hard-error`, `:soft-truncation`, `:empty-response`, `:provider-message` |
| `raw_signal` | string? | Raw provider message |

---

### 8. `account_cooldown_initiated`

| Field | Type | Notes |
|---|---|---|
| `reason` | CooldownReason | `:quota-short`, `:quota-weekly`, `:error-rate`, `:latency`, `:manual` |
| `cooldown_until` | int | Epoch ms |
| `triggering_event_id` | string? | FK to the event that caused this |

---

### 9. `account_cooldown_expired`

| Field | Type | Notes |
|---|---|---|
| `cooldown_initiated_at` | int | Epoch ms |
| `cooldown_reason` | CooldownReason | |

---

### 10. `quota_reset_detected`

| Field | Type | Notes |
|---|---|---|
| `window_type` | QuotaWindowType | `:short`, `:long`, `:weekly`, `:unknown` |
| `detected_via` | enum | `:explicit-api`, `:inferred-from-traffic`, `:manual` |
| `tokens_available` | int? | If known |
| `reset_at` | int? | Epoch ms |

---

### 11. `account_health_degraded` / `account_health_improved`

| Field | Type | Notes |
|---|---|---|
| `health_score_before` | double | |
| `health_score_after` | double | |
| `degraded_threshold` / `recovery_threshold` | double | Configurable per provider |
| `contributing_metrics` | map? | `error_rate`, `p50_latency_ms`, `p99_latency_ms`, `quota_pressure` |

---

## Provider Cache Config

| Provider | Cache TTL | Short Quota Window | Long Quota Window |
|---|---|---|---|
| OpenAI | 24h | 5h | 1 week |
| Anthropic | 24h | 1h | 30 days |
| Ollama Cloud | 4h | 4h | 1 week |

These values are defined in `proxx.ledger.projector/provider-cache-config`
and used by `cache-recoverable?` to decide whether account A can reclaim
affinity after having been displaced by account B.

---

## Quota Reset and Cache Recovery Logic

Account A can re-claim affinity for a session if **all** of the following hold:

1. `now - last_success_with_A < provider.cache_ttl`
2. `now - last_failure_with_A >= provider.short_quota_window`
3. No `session_churn_detected` or `context_overflow_detected` events occurred
   after `last_success_with_A`
4. Current epoch for `(session, provider, A, model)` is still valid

If these conditions hold, the router may reuse the **same epoch / derived cache key**
for account A, preserving the provider-side prompt cache.

Otherwise, a new epoch begins, a new `derived_cache_key` is computed, and the
old affinity record becomes unreachable.

---

## Relationship to `requests.jsonl`

The existing `requests.jsonl` file captures per-request attempt data.
The events above are **higher-level signals** derived from one or more request
attempts, or from account/session state changes that cross request boundaries.

Both logs feed the projection functions; neither replaces the other.
