# Π Last Snapshot — PR #215 into staging

- Timestamp: 2026-05-30T01:16:12Z
- Branch: `pi/proxx-pr215-into-staging-20260530T004530Z`
- Base: `origin/staging@6a132ef`
- Source PR: https://github.com/open-hax/proxx/pull/215
- Source commits: `5f8d3f0`, `5cf6280`
- Intent: land the PR #215 requested-provider CLJS policy runtime fixes into staging after `chores/policy-driven-embeddings` was merged without those commits.

## Changed

- Cherry-picked the PR #215 policy/runtime/test commits onto current staging.
- CLJS policy interpreter filters by declarative request-surface defaults and requested provider facts before tenant provider enforcement.
- `/v1/embeddings` supplies requested provider facts derived from explicit `llamacpp-embed`, `ollama`, or exact Ollama-family model prefixes.
- Native Ollama `/api/embed` and `/api/embeddings` bridge requests enter `/v1/embeddings` scoped as native Ollama requests, independent of prefix-list order.
- Added CLJS, policy-preview, and proxy regression coverage.

## Boundary

- Did not edit `services/proxx/policies/**`.
- Did not edit `orgs/open-hax/proxx/resources/policies/**` EDN.
- The service overlay and package resource policy trees remain distinct.

## Verification

- `pnpm install --frozen-lockfile` passed.
- `pnpm test:cljs` passed: 113 tests, 302 assertions; 8 pre-existing infer warnings.
- `pnpm build:cljs` passed.
- Targeted proxy tests passed: tenant-disabled Ollama, explicit `ollama-lan`, native `/api/embed`, and native prefix-order coverage: 4/4.
- `pnpm test` passed: 643 tests, 641 pass, 2 skipped, 0 fail.
- `pnpm test:coverage` passed: 643 tests, 641 pass, 2 skipped, 0 fail; all files lines 81.81%, branches 73.01%, funcs 78.53%.
- Touched TS eslint `--quiet` passed.
- `git diff --check` passed.

## Note

- An initial targeted `tsx` run failed before `pnpm build:cljs` because the fresh worktree had no `dist/cljs/proxx-runtime.js`; after `pnpm build:cljs`, the same targeted tests passed.
