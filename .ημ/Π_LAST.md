# Π Fork Tax Snapshot — proxx

- Timestamp: 20260518T061200Z
- Branch: chore/consolidate-examples
- Base: c9c2800d3df4
- Scope: CI workflow Java setup for shadow-cljs + eslint CJS ignore fix.

## Included work

- Added `actions/setup-java@v4` (temurin, Java 21) to all workflows running `pnpm build`/`pnpm test`
- Added `actions/cache@v4` for `.shadow-cljs` and `~/.m2/repository` alongside Java setup
- Workflows fixed: `main-pr-gate.yml`, `staging-pr.yml`, `deploy-testing.yml`, `deploy-staging.yml`, `deploy-production.yml`
- Fixed eslint `ignores` pattern: `"*.cjs"` → `"**/*.cjs"` so CJS files in subdirectories are ignored

## Verification

- `pnpm build` passed (tsc + shadow-cljs).
- `npx tsx --test src/tests/schema-migration.test.ts` passed (5/5).
- `actionlint` passed on all modified workflow files.
- `pnpm run typecheck` passed.

## Residual dirt

- `.clj-kondo/imports/` and `.lsp/` are tooling artifacts left uncommitted.
- `.#route-filtering.ts` emacs lock file left untracked.
