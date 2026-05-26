# jscpd code duplication report

Date: 2026-05-21

## Setup

- Added `.jscpd.json` at the Proxx repo root.
- Added `pnpm duplication:scan` and `pnpm duplication:check` to `package.json`.
- Added `.github/workflows/code-quality.yml` so the duplication gate runs on pull requests and pushes to `main` / `staging`.
- Added `docs/code-quality.md` and a README Code Quality section describing scope, thresholds, ignored paths, and triage guidance.
- Scanner command: `pnpm dlx jscpd@4.0.5 --config .jscpd.json`.
- Raw machine report: `reports/jscpd/jscpd-report.json`.

## Scan scope

The configured scan targets hand-authored executable and policy code while excluding dependency, build, generated, local-runtime, cache, worktree, lockfile, sourcemap, declaration, minified, and backup artifacts.

Configured roots:

- `src`
- `test`
- `web/src`
- `web/test`
- `scripts`
- `resources`
- `deploy`
- `examples`
- `pseudo`

Thresholds:

- `minLines`: 8
- `minTokens`: 80
- total duplication scan threshold: 100% for local report generation
- total duplication gate: 5% for CI / pre-merge checks

## Refactors completed

### 1. Provider strategy response-stream consolidation

The first production-code pass targeted the provider strategy hotspot because it represented request/response plumbing duplication on a sensitive routing path.

Changes:

- Extracted the duplicate OpenAI Codex Responses strategy body into one `OpenAiCodexResponsesStrategy` base class while preserving the two strategy modes:
  - `openai_responses`
  - `openai_chat_completions`
- Extracted shared Responses SSE-to-chat-completions handling into `src/lib/provider-strategy/strategies/responses-event-stream.ts`.
- Reused the shared SSE handler from both:
  - `src/lib/provider-strategy/strategies/openai.ts`
  - `src/lib/provider-strategy/strategies/factory.ts`

This removed the largest production clone pair in `openai.ts` and the large `factory.ts` ↔ `openai.ts` Responses event-stream clone while keeping provider-specific matching, payload shaping, headers, and Factory JSON fallback behavior explicit.

## Current result summary

`pnpm duplication:scan` and `pnpm duplication:check` complete successfully. The total duplicated-line percentage is below the configured 5% gate.

| Metric | Initial scan | After provider strategy pass |
|---|---:|---:|
| Files analyzed | 306 | 307 |
| Lines analyzed | 60,611 | 60,427 |
| Tokens analyzed | 575,899 | 574,170 |
| Clone groups | 126 | 123 |
| Duplicated lines | 2,607 | 2,421 |
| Duplicated line percentage | 4.30% | 4.01% |
| Duplicated tokens | 26,536 | 24,874 |
| Duplicated token percentage | 4.61% | 4.33% |

Net reduction from the initial scan:

- clone groups: -3
- duplicated lines: -186
- duplicated line percentage: -0.29 percentage points
- duplicated tokens: -1,662

## Current breakdown by format

| Format | Files | Lines | Clones | Duplicated lines | % lines | % tokens |
|---|---:|---:|---:|---:|---:|---:|
| clojure | 45 | 5,604 | 1 | 12 | 0.21% | 0.25% |
| javascript | 14 | 2,037 | 1 | 31 | 1.52% | 1.52% |
| typescript | 236 | 49,582 | 114 | 2,251 | 4.54% | 4.90% |
| tsx | 12 | 3,204 | 7 | 127 | 3.96% | 4.54% |

## Current top duplicated files

| Duplicated lines | % | Clones | Format | File |
|---:|---:|---:|---|---|
| 296 | 50.25% | 12 | typescript | `src/tests/federation-bridge-relay.test.ts` |
| 287 | 40.42% | 13 | typescript | `src/tests/factory-config.test.ts` |
| 180 | 66.18% | 6 | typescript | `src/tests/federation-bridge-autostart.test.ts` |
| 164 | 37.44% | 7 | typescript | `src/lib/provider-strategy/strategies/standard.ts` |
| 158 | 36.49% | 9 | tsx | `web/src/pages/AnalyticsPage.tsx` |
| 140 | 20.38% | 7 | typescript | `src/tests/gemini-strategy.test.ts` |
| 119 | 19.77% | 7 | typescript | `src/tests/factory-strategy.test.ts` |
| 108 | 85.71% | 5 | typescript | `src/routes/api/ui/hosts/index.ts` |
| 103 | 18.90% | 4 | typescript | `src/lib/provider-strategy/base.ts` |
| 100 | 10.18% | 6 | typescript | `src/lib/openai-quota.ts` |
| 97 | 73.48% | 4 | typescript | `src/routes/hosts/index.ts` |
| 93 | 32.18% | 4 | typescript | `src/routes/api/ui/bridge-sse.ts` |
| 91 | 29.45% | 3 | typescript | `src/lib/provider-strategy/strategies/factory.ts` |
| 90 | 17.58% | 2 | typescript | `src/lib/db/event-store.ts` |
| 88 | 29.63% | 4 | typescript | `src/lib/provider-strategy/strategies/embeddings.ts` |

## Largest current clone pairs

| Lines | Format | First | Second |
|---:|---|---|---|
| 96 | typescript | `src/tests/federation-bridge-autostart.test.ts:58-153` | `src/tests/federation-bridge-relay.test.ts:30-125` |
| 75 | typescript | `src/lib/bridge-helpers.ts:2-76` | `src/lib/federation/bridge-request-helpers.ts:3-77` |
| 60 | typescript | `src/lib/provider-strategy/strategies/factory.ts:64-123` | `src/lib/provider-strategy/strategies/standard.ts:289-347` |
| 46 | typescript | `src/lib/db/event-store.ts:301-346` | `src/lib/db/event-store.ts:240-285` |
| 42 | typescript | `src/lib/observability/request-log-sse-hub.ts:85-126` | `src/lib/observability/request-log-ws-hub.ts:29-70` |
| 38 | typescript | `src/routes/hosts/index.ts:96-133` | `src/routes/api/ui/hosts/index.ts:62-127` |
| 36 | typescript | `src/lib/provider-strategy/base.ts:397-432` | `src/lib/provider-strategy/base.ts:359-394` |
| 33 | typescript | `src/lib/ollama-compat.ts:1-33` | `src/lib/ollama-native.ts:1-33` |
| 32 | tsx | `web/src/pages/AnalyticsPage.tsx:272-303` | `web/src/pages/AnalyticsPage.tsx:245-276` |
| 32 | javascript | `web/src/App.tsx:164-195` | `web/src/App.tsx:152-182` |
| 30 | typescript | `src/lib/provider-catalog.ts:365-394` | `src/lib/provider-catalog.ts:302-330` |
| 29 | typescript | `src/routes/hosts/index.ts:68-96` | `src/routes/api/ui/hosts/index.ts:62-90` |

## Investigation notes

### 1. Provider strategy TypeScript remains the top production-code target

The largest production hotspot after the first pass is now `FactoryResponsesPassthroughStrategy` vs `ResponsesPassthroughStrategy`, plus base strategy response handling. These are still important because duplicated stream passthrough and response-copying code can drift across provider surfaces.

Recommended fix: extract a shared successful passthrough handler for OpenAI-compatible Responses passthrough, Factory Responses passthrough, and base local/upstream response copying, while preserving provider-specific auth/header/payload decisions.

### 2. Federation test setup repeats across suites

`src/tests/federation-bridge-autostart.test.ts`, `src/tests/federation-bridge-relay.test.ts`, and related factory tests duplicate large setup blocks. This is usually safer to refactor than production routing code because the repeated shape is mostly fixture construction and mock service scaffolding.

Recommended fix: extract shared federation bridge fixtures and fake relay helpers while keeping assertions local to each behavior.

### 3. Bridge helper duplication is likely a direct consolidation candidate

`src/lib/bridge-helpers.ts` and `src/lib/federation/bridge-request-helpers.ts` share a 75-line clone. This looks like an accidental split between generic bridge helpers and federation-specific bridge request helpers.

Recommended fix: choose one canonical helper module and re-export compatibility aliases from the other if existing imports need to remain stable.

### 4. UI route aliases duplicate host/event handling

`src/routes/hosts/index.ts`, `src/routes/api/ui/hosts/index.ts`, `src/routes/events/index.ts`, and `src/routes/api/ui/events/index.ts` duplicate request handling for old and new UI route surfaces. Some alias duplication may be intentional for route clarity.

Recommended fix: preserve explicit route registration, but move repeated handler bodies into shared private functions.

### 5. Frontend duplication is concentrated in dashboard/analytics surfaces

`web/src/pages/AnalyticsPage.tsx`, `web/src/pages/DashboardPage.tsx`, and `web/src/App.tsx` contain repeated metric card and navigation/render branches.

Recommended fix: extract presentational metric-card/list primitives only after verifying the pages are not intentionally diverging.

## Verification

Commands run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('.jscpd.json','utf8')); console.log('json-ok')"
pnpm duplication:scan
pnpm duplication:check
pnpm build:ts
npx tsx --test src/tests/provider-routing.test.ts src/tests/factory-strategy.test.ts src/tests/factory-oauth.test.ts
pnpm build
pnpm exec eslint src/lib/provider-strategy/strategies/openai.ts src/lib/provider-strategy/strategies/factory.ts src/lib/provider-strategy/strategies/responses-event-stream.ts --quiet
```

Results:

- JSON validation passed.
- `pnpm duplication:scan` passed and wrote ignored reports to `reports/jscpd/`.
- `pnpm duplication:check` passed with 4.01% duplicated lines against the 5% gate.
- `pnpm build:ts` passed.
- Focused provider/factory tests passed: 43 pass, 0 fail.
- `pnpm build` passed, including TypeScript and shadow-cljs runtime release.
- Focused ESLint on touched provider-strategy files passed.
