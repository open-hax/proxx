---
uuid: "b7f318ae-dff2-40ee-9fb3-41f472f2c59c"
title: "Spec 1.4: Move rate-limit classification from TypeScript into EDN policy"
status: incoming
priority: P1
labels: ["bug", "policy", "rate-limiting", "refactor"]
created_at: "2026-06-08T21:15:00.000Z"
source: "kanban/xiaomi-mimo-streaming-timeout-epic/04-rate-limit-policy-extraction.md"
category: "bug"
---

> Source: `kanban/xiaomi-mimo-streaming-timeout-epic/04-rate-limit-policy-extraction.md`
> Migrated-to-kanban: `kanban/xiaomi-mimo-streaming-timeout-epic/04-rate-limit-policy-extraction.md`

# Spec 1.4: Move rate-limit classification from TypeScript into EDN policy

**Spec ID:** XIAOMI-STREAM-TRUNC-001-04
**Epic:** [xAIoMi Mimo-v2.5-pro Silent Stream Truncation](./EPIC.md)
**Points:** 3
**Priority:** P1
**Dependencies:** None

## Objective

Extract the imperative `classifyRateLimitKind` heuristic from `src/lib/proxy.ts` and replace it with a declarative EDN policy contract evaluated by the CLJS runtime. Generic heuristics remain as CLJS fallback defaults; provider-specific overrides move to EDN. No new TypeScript business logic.

## Current State

`src/lib/proxy.ts:211-268` contains a 58-line imperative function that:
1. Hardcodes Ollama session/weekly limit detection
2. Hardcodes a list of quota keywords ("usage limit", "quota", "exhausted", etc.)
3. Hardcodes a list of concurrency indicators ("concurrent", "too many requests", etc.)
4. Applies a 30-second retry-after threshold heuristic
5. Defaults everything to `quota_exhausted`

This violates the policy boundary: provider-specific behavior is declared in TypeScript instead of EDN.

## Target State

A new contract kind `:rate-limit-behavior` in the EDN policy layer that allows each provider to declare how its 429 responses should be classified. The CLJS runtime evaluates this contract during routing, and TypeScript only reads the result.

### Contract schema

```edn
{:contract/id :rate-limit-behavior/xiaomi
 :contract/kind :rate-limit-behavior
 :match/provider-pattern "^xiaomi$"
 :rate-limit/classification :quota_exhausted
 :rate-limit/retry-behavior :failover-immediately}
```

Using `:match/provider-pattern` (regex) keeps the DSL consistent with `:provider-capability` contracts. Optional fields allow overriding heuristic inputs:

- `:rate-limit/quota-keywords` — override default quota keyword list
- `:rate-limit/concurrency-keywords` — override default concurrency keyword list
- `:rate-limit/concurrency-threshold-ms` — override retry-after threshold (default 30000)

### Fallback behavior

Generic heuristics (quota keywords, concurrency indicators, 30s threshold) remain as CLJS fallback defaults for providers without explicit `:rate-limit-behavior` contracts. This preserves safe behavior for unconfigured providers.

## Implementation Steps

1. **Add Malli schema** (`src/proxx/schema.cljs`):
   - Define `RateLimitBehaviorContract` schema
   - Add to `PolicyContract` multi-schema so the loader accepts it
   - Add to `contract-kinds` set

2. **Add contract extractor** (`src/proxx/policy/contracts.cljs`):
   - Extract `:rate-limit-behavior` contracts into a compiled index (provider-id → contract)
   - O(1) lookup in `compile-contracts`

3. **Write classification function** (`src/proxx/policy.cljs` or new ns):
   - `rate-limit-classification` takes provider-id, response body, retry-after-ms
   - Look up provider's contract; if found, use declared classification
   - If not found, apply generic heuristics (current behavior)
   - Returns keyword `:quota_exhausted` or `:concurrency_throttle`

4. **Export to runtime** (`src/proxx/runtime.cljs`):
   - Wrap `rate-limit-classification` with `clj->js` conversion
   - Export as `rateLimitClassification` function

5. **Update TS interop** (`src/lib/cljs-runtime.ts`):
   - Add `rateLimitClassification` to `ProxxCljsRuntime` interface
   - Make it optional in `isProxxCljsRuntime` validator (rolling deploy safety)

6. **Modify routing executor** (`src/lib/provider-strategy/routing/attempt-executor.ts`):
   - Replace `classifyRateLimitKind` import/call with CLJS runtime call
   - Pass provider-id, response body, retry-after-ms
   - Apply retry/failover logic based on returned classification

7. **Migrate existing heuristics**:
   - Move Ollama session/weekly detection into EDN contract (`:rate-limit-behavior/ollama-cloud`)
   - Move xiaomi override into EDN contract (`:rate-limit-behavior/xiaomi`)
   - Optionally add zai contract (`:rate-limit-behavior/zai` with `:concurrency_throttle` / `:retry-same`)
   - Keep generic keyword lists as CLJS fallback defaults

8. **Deprecate TS heuristic** (`src/lib/proxy.ts`):
   - Remove or demote `classifyRateLimitKind` to a thin wrapper that logs a deprecation warning
   - Remove `detectOllamaLimitKind` (moved to EDN)

9. **Test**:
   - CLJS policy preview tests for each provider's classification
   - Integration test: mock xiaomi 429, verify failover to second key
   - Regression test: generic heuristic still classifies "too many requests" as `concurrency_throttle` when no contract matches
   - Verify no regression for ZAI (still retries same credential)
   - Run `pnpm build`, `pnpm run check:no-new-typescript`, proxy test suite

## Acceptance Criteria

- [ ] `classifyRateLimitKind` in `proxy.ts` delegates to CLJS policy runtime (or removed)
- [ ] Provider-specific rate limit behavior declared in EDN, not TypeScript
- [ ] xiaomi 429s trigger immediate failover to next key (no concurrency retry loop)
- [ ] Ollama session/weekly limits correctly classified via EDN contract
- [ ] ZAI and other concurrency-throttled providers still retry same credential when appropriate
- [ ] Generic heuristic preserved as fallback for unconfigured providers
- [ ] All existing tests pass
- [ ] New policy preview tests for rate limit classification
- [ ] `rateLimitClassification` optional in `isProxxCljsRuntime` (rolling deploy safety)

## Risk Assessment

**Risk Level:** Medium

- Touches core routing decision path
- Must not break existing provider behavior
- CLJS/TS interop boundary change
- Requires careful testing of all provider types
- Malli schema must be correct or loader throws on startup

## Estimated Time

8-10 hours

## Verification

```clojure
;; CLJS policy preview test
(deftest rate-limit-classification-test
  (let [result (proxx.policy/rate-limit-classification
                "xiaomi"
                {:error {:message "Too many requests"}}
                5000)]
    (is (= :quota-exhausted (:classification result)))
    (is (= :failover-immediately (:retry-behavior result)))))
```
