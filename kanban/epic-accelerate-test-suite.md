---
uuid: "26913ee3-423b-4cd2-bfe6-229857a610af"
title: "Epic: Accelerate Test Suite & Eliminate Live Provider Dependencies"
status: incoming
priority: P2
labels: ["specs", "migrated-spec"]
created_at: "2026-06-01T14:51:33.085Z"
source: "specs/epic-accelerate-test-suite.md"
category: "specs"
---

> Source: `specs/epic-accelerate-test-suite.md`
> Migrated-to-kanban: `kanban/epic-accelerate-test-suite.md`

# Epic: Accelerate Test Suite & Eliminate Live Provider Dependencies

## Problem Statement

`pnpm test` currently takes **~2.5–3 minutes** and produces **extremely verbose logs** (full Pino JSON output for every request). This breaks agent workflows (session summaries truncate the output) and slows the local dev loop. Historically some tests intentionally hit live provider APIs to verify behavior during rapid upstream churn; now that provider behavior is stable, we should fully mock these paths.

## Goals

1. **Cut test runtime to < 30s** from ~150s
2. **Eliminate live provider calls** from the automated test suite
3. **Reduce log verbosity** to readable assertion failures only
4. **Preserve confidence**: coverage must not drop; live e2e can remain as a separate nightly/smoke script

## Root Causes (from audit)

| Cause | Impact | Location |
|---|---|---|
| `--test-concurrency=1` | All 646 tests run sequentially | `package.json` |
| Full Fastify + CLJS cold boot per `withProxyApp()` call | ~20–50ms per test × 500+ tests adds up | `src/tests/proxy.test.ts` |
| Tests use `{ concurrency: false }` heavily | Even within a file, tests queue | `proxy.test.ts` passim |
| Long synthetic timeouts / sleeps | `openai responses passthrough closes stalled streaming bodies` takes **33s** | `proxy.test.ts:408` |
| Pino logger outputs every request at `info` level | Walls of JSON in test output | `createApp()` logging config |
| Some tests still reach out to real endpoints (e.g., quota fetching) | Flaky, slow, requires env vars | Quota / catalog tests |
| `pnpm test` always runs `pnpm build` first | Adds ~20–30s even when sources are unchanged | `package.json` |

## Phases

### Phase 1: Silence Logs & Parallelize (2 points)
**Goal: Immediate developer-experience win**

- [ ] Add `silent: true` or `level: 'fatal'` to `createApp()` when `NODE_ENV=test` or a new `TEST_QUIET=1` flag is set
- [ ] Change `pnpm test` to use `--test-concurrency=8` (or `os.availableParallelism()`) instead of `1`
- [ ] Ensure tests that mutate `process.env` or global state are isolated with `test.concurrency = false` only where truly necessary
- [ ] Update `withProxyApp()` to default to a null logger unless explicitly overridden

**Acceptance:**
- `pnpm test` output fits in a single terminal screen of TAP summaries
- Runtime drops to ~60–90s

### Phase 2: Extract Shared Test Fixture (3 points)
**Goal: Stop cold-booting Fastify for every single test**

- [ ] Introduce a shared `testServer` helper that boots **one** Fastify app per test *file* and reuses it across tests
- [ ] Reset mutable state (key-pool cooldowns, request logs, affinities) between tests via a `resetTestState()` call instead of `app.close()` + `createApp()`
- [ ] Keep `withProxyApp()` for tests that genuinely need a custom upstream handler, but make the common case use the shared fixture

**Acceptance:**
- `proxy.test.ts` runtime drops by > 50%
- No test leakage between runs (run file 10× in a row, still passes)

### Phase 3: Eliminate Real Network Calls (3 points)
**Goal: Make the suite 100% offline**

- [ ] Audit every test that uses `withPatchedFetch()` or real `fetch` and replace with the mock upstream pattern
- [ ] Move the OpenAI quota-fetching test (`fetches live OpenAI Codex quota windows…`) to a new `src/tests/live/` directory excluded from `pnpm test`
- [ ] Move catalog-discovery timeout tests to use a controlled `nock`-style mock or a local server that intentionally hangs
- [ ] Ensure `QUOTA_MONITOR_INTERVAL_MS` can be set to `0` in tests to disable the background quota checker
- [ ] Ensure `PROXY_PROVIDER_CATALOG_ROUTE_TIMEOUT_MS` tests use a local server, not a real endpoint

**Acceptance:**
- `pnpm test` passes with `network_interface=lo` only (no external routes)
- `scripts/e2e-test.sh` remains unchanged as the live smoke layer

### Phase 4: Shrink Timeout Tests (2 points)
**Goal: Stop waiting 30s for a timeout to fire**

- [ ] Refactor `openai responses passthrough closes stalled streaming bodies` to use a fake `AbortController` or a mock stream that emits the timeout immediately, rather than waiting the real 30s
- [ ] Refactor stream-bootstrap-timeout tests to use a synthetic clock or a very short timeout (e.g. `10ms`) instead of `2000ms` defaults
- [ ] Audit all `waitFor()` helpers in federation tests and stub their timers

**Acceptance:**
- No single test takes longer than 2s
- Total suite runtime < 30s

### Phase 5: Incremental Build for Local Dev (1 point)
**Goal: Skip unnecessary rebuilds**

- [ ] Introduce `pnpm test:fast` that runs `node --test` directly against `dist/` *without* `pnpm build`
- [ ] Update CI to keep `pnpm test` (build + test) for safety
- [ ] Document the workflow in `AGENTS.md`

**Acceptance:**
- Iterating on a single test file takes < 5s from save to result

## Success Metrics

| Metric | Before | After |
|---|---|---|
| `pnpm test` duration | ~150s | < 30s |
| Log lines per run | ~5,000+ JSON lines | < 50 lines |
| External network calls per run | ~2–5 (quota, catalog) | 0 |
| Tests requiring `concurrency: false` | ~30% | < 5% |
| Agent session truncation risk | High | Low |

## Non-Goals

- Do not remove `scripts/e2e-test.sh` — it is the live smoke layer and should stay
- Do not refactor the entire test framework to Vitest/Jest — keep Node built-in test runner
- Do not mock the CLJS policy engine — it is fast and deterministic; keep testing it

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Parallel tests leak mutable state | Use `beforeEach` reset helpers; keep `concurrency: false` only for stateful tests |
| Shared fixture hides isolation bugs | Run the full suite 5× in CI to detect flakes before merge |
| Moving tests to `live/` drops coverage | Add a nightly CI job that runs `live/` tests and reports coverage separately |
| Silent logs hide real failures | Keep `level: 'fatal'` only; fatal errors still print |

## Next Step

Create the first spec for **Phase 1: Silence Logs & Parallelize** and begin implementation.
