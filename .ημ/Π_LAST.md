# Π Fork Tax Snapshot — proxx

- Timestamp: 20260518T034823Z
- Branch: chore/consolidate-examples
- Base: a504f3ee4fe7
- Scope: CLJS queue runtime, route consolidation, provider strategy refactoring.

## Included work

- CLJS queue runtime (`src/proxx/queue/`, `test/proxx/queue/`)
- Policy contracts and runtime extensions (`src/proxx/policy/contracts.cljs`, `src/proxx/runtime.cljs`)
- Route consolidation for chat, embeddings, images, media-generations, responses
- Provider strategy refactoring: contexts, attempt-executor, candidate-builder
- Provider utils extracted (`src/lib/provider-utils.ts`)
- CLJS policy shadow bridge expanded (`src/lib/policy/cljs-shadow.ts`)
- Spec/audit moved from `spec/` to `specs/`
- Workspace config added (`pnpm-workspace.yaml`)
- Emacs lock file and LSP artifacts excluded from commit

## Verification

- `pnpm build` passed (tsc + shadow-cljs).
- `git diff --cached --check` passed.

## Residual dirt

- `.clj-kondo/imports/` and `.lsp/` are tooling artifacts left uncommitted.
- Proxx auxiliary worktrees under `.worktrees/` remain separate branch scopes.
