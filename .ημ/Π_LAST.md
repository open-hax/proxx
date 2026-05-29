# Π Last Snapshot — Proxx requested-provider policy facts

- Timestamp: 2026-05-29T22:49:00Z
- Branch: `pi/proxx-policy-requested-provider-facts-20260529T215446Z`
- Base: `origin/chores/policy-driven-embeddings`
- Initial commit: `5f8d3f0`
- Intent: keep embedding provider selection declarative by passing request facts into the CLJS policy interpreter.

## Changed

- CLJS policy interpreter filters by declarative request-surface defaults and requested provider facts before tenant provider enforcement.
- `/v1/embeddings` supplies explicit `ollama` / `llamacpp-embed` provider facts from model prefixes.
- Native Ollama `/api/embed` and `/api/embeddings` bridge requests enter `/v1/embeddings` scoped as Ollama requests.
- Added CLJS and Node preview tests for requested-provider facts.
- Requested-provider route tests assert selected provider identity without depending on optional provider-route path metadata.

## CodeRabbit follow-up

- Triggered manual CodeRabbit review on PR #215.
- Addressed both actionable comments:
  - Explicit Ollama embedding prefixes now preserve the exact requested provider id, e.g. `ollama-lan/` no longer collapses to `ollama`.
  - Native Ollama embed bridge now scopes unprefixed native requests to the explicit native `ollama/` or `ollama:` prefix, not whichever Ollama-like prefix appears first in config order.
- Added regression coverage for both cases in `src/tests/proxy.test.ts`.

## Boundary

- Did not edit `services/proxx/policies/**`.
- Did not edit `orgs/open-hax/proxx/resources/policies/**` EDN.
- The two policy trees remain distinct; this PR changes interpreter/request-fact behavior and request scoping only.

## Verification

- Targeted `npx tsx --test --test-name-pattern 'explicit ollama-lan|native /api/embed scopes|tenant disabledProviderIds blocks local ollama usage|proxies native /api/embed' src/tests/proxy.test.ts` passed: 4/4.
- `pnpm test` passed: 643 tests, 641 pass, 2 skipped, 0 fail.
- `pnpm test:coverage` passed: 643 tests, 641 pass, 2 skipped, 0 fail; all files lines 81.77%, branches 72.87%, funcs 78.45%.
- `pnpm test:cljs` passed: 113 tests, 302 assertions; 8 pre-existing infer warnings.
- Touched TS eslint `--quiet` passed.
- `git diff --check` passed.
