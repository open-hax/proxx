---
uuid: "e46286fd-3668-4f64-aa5b-30b88130ae86"
title: "Spec 1.2: Streaming-aware queue timeout"
status: incoming
priority: P2
labels: ["bug", "streaming", "queue", "policy"]
created_at: "2026-06-08T20:30:00.000Z"
source: "kanban/xiaomi-mimo-streaming-timeout-epic/02-streaming-aware-timeout.md"
category: "bug"
---

> Source: `kanban/xiaomi-mimo-streaming-timeout-epic/02-streaming-aware-timeout.md`
> Migrated-to-kanban: `kanban/xiaomi-mimo-streaming-timeout-epic/02-streaming-aware-timeout.md`

# Spec 1.2: Streaming-aware queue timeout

**Spec ID:** XIAOMI-STREAM-TRUNC-001-02
**Epic:** [xAIoMi Mimo-v2.5-pro Silent Stream Truncation](./EPIC.md)
**Points:** 2
**Priority:** High
**Dependencies:** None

## Objective

Make the CLJS queue runtime aware of streaming state so that the attempt timer can be extended once streaming begins, preventing mid-stream truncation while keeping pre-stream timeouts strict.

## Current State

- `src/proxx/queue/runtime.cljs:110` - `effective-timeout-ms` uses static `attempt-timeout-ms`
- `src/proxx/queue/runtime.cljs:125-133` - `run-attempt` arms abort timer at task start
- Once streaming starts in `streamEventStreamToClient`, the timer keeps counting
- Abort signal fires at 30s regardless of stream progress

## Target State

The queue runtime provides an `extendTimeout` capability to the task. When the task signals that streaming has started successfully, the timer resets to a new `stream-timeout-ms` value read from EDN policy.

## Design

### Option A: Reset timer on stream start (selected)

- In `run-attempt`, attach `extendTimeout` as a JS property on the `AbortController` instance
- The TS side accesses it via `(controller as any).extendTimeout(ms)` with a runtime guard
- After `bootstrapEventStream` returns `{kind: "ready", ...}`, the stream handler calls `extendTimeout`
- New timeout duration read from `:queue/stream-timeout-ms` in EDN policy (default 120000 = 2min)

### Guard against timer leaks

Use a `completed?` atom to prevent late `extendTimeout` calls from re-arming a timer after `run-attempt` has finished:

```clojure
(let [completed? (atom false)
      extend-timeout! (fn [extra-ms]
                        (when-not @completed?
                          (js/clearTimeout @timer-ref)
                          (reset! timer-ref (arm-abort-timer! controller extra-ms))))]
  ...
  (finally
    (reset! completed? true)
    (js/clearTimeout @timer-ref)))
```

### Rejected alternatives

- **Option B: Separate bootstrap/stream timeouts** — The queue runtime sees one opaque promise. It cannot distinguish phases without the task signaling, which is the same callback problem as Option A.
- **Option C: Heartbeat-based timeout** — Overkill. Requires periodic signaling from stream reader. Adds complexity for a problem that only needs one phase transition.

## Implementation Steps

1. **Extend CLJS queue runtime** (`src/proxx/queue/runtime.cljs`):
   - Add `:queue/stream-timeout-ms` to `queue-policy-keys` in `src/proxx/queue/policy.cljs`
   - Modify `run-attempt` to attach `extendTimeout` property to controller
   - Guard with `completed?` atom to prevent leaks

2. **Add EDN config** (`resources/policies/runtime/70-request-queue-templates.edn`):
   - Add `:queue/stream-timeout-ms` to `:queue/default` template (default 120000)
   - Verify schema accepts the new key

3. **Modify stream handler** (`src/lib/provider-strategy/base.ts`):
   - After `bootstrapEventStream` returns `ready`, access controller via closure or context
   - Call `extendTimeout` with `context.config.streamTimeoutMs` (or read from policy)

4. **Test**:
   - CLJS unit test: mock controller with attached property, verify timer extends
   - Integration test: mock slow stream, verify queue does not abort mid-stream
   - Verify non-streaming tasks never call `extendTimeout` (no regression)

## Acceptance Criteria

- [ ] Queue timer extends when streaming starts
- [ ] Streams longer than `attempt-timeout-ms` complete successfully
- [ ] Pre-stream timeouts (routing, bootstrap) still enforced
- [ ] Configurable via EDN policy (`:queue/stream-timeout-ms`), not env var
- [ ] No regression for non-streaming requests
- [ ] Timer leaks prevented by `completed?` guard

## Risk Assessment

**Risk Level:** Medium

- Touches core queue runtime (CLJS)
- Timer state management is tricky in async contexts
- Must not leak timers on early abort
- CLJS/TS interop boundary change
- Needs thorough testing of edge cases

## Estimated Time

6-8 hours

## Verification

```clojure
;; CLJS test snippet
(deftest ^:async stream-timeout-extension
  (let [policy {:queue/attempt-timeout-ms 5000
                :queue/stream-timeout-ms 30000}
        task (fn [controller]
               (js/Promise.
                (fn [resolve _]
                  (js/setTimeout
                   #(do (when-let [ext (.-extendTimeout controller)]
                          (ext 25000))
                        (js/setTimeout resolve 20000))
                   1000))))]
    ;; Should succeed (1s bootstrap + 20s stream = 21s < 5s+25s extended)
    (is (await (run! task policy)))))
```
