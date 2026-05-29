# Π Last Snapshot — Proxx requested-provider policy facts

- Timestamp: 2026-05-29T22:07:06Z
- Branch: `pi/proxx-policy-requested-provider-facts-20260529T215446Z`
- Base: `origin/chores/policy-driven-embeddings`
- Intent: keep embedding provider selection declarative by passing request facts into the CLJS policy interpreter.

## Changed

- CLJS policy interpreter now filters by declarative request-surface defaults and requested provider facts before tenant provider enforcement.
- `/v1/embeddings` now supplies explicit `ollama` / `llamacpp-embed` provider facts from model prefixes.
- Native Ollama `/api/embed` and `/api/embeddings` bridge requests enter `/v1/embeddings` scoped as Ollama requests.
- Added CLJS and Node preview tests for requested-provider facts.
- Requested-provider route tests assert selected provider identity without depending on optional provider-route path metadata.

## Boundary

- Did not edit `services/proxx/policies/**`.
- Did not edit `orgs/open-hax/proxx/resources/policies/**` EDN.
- The two policy trees remain distinct; this PR changes interpreter/request-fact behavior.

## Verification

- `pnpm test:cljs` passed: 113 tests, 302 assertions; 8 pre-existing infer warnings.
- `pnpm test` passed: 641 tests, 639 pass, 2 skipped, 0 fail.
- `pnpm test:coverage` passed: 641 tests, 639 pass, 2 skipped, 0 fail; all files lines 81.77%, branches 72.94%, funcs 78.45%.
- Touched TS eslint `--quiet` passed.
- `git diff --check` passed.
