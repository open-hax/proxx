(fork-tax-state
  (timestamp "2026-06-02T05:59:56Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx")
  (branch "docs/prod-gpt55-example")
  (base "origin/staging")
  (intent "Preserve final residual DEVEL.md production gpt-5.5 example dirt through protected PR flow after merging all previously-open Proxx PRs and PR #260 promotion.")
  (owned-paths
    "DEVEL.md"
    "receipts.edn"
    ".ημ/Π_LAST.md"
    ".ημ/Π_STATE.sexp"
    ".ημ/Π_MANIFEST.sha256")
  (merged-prs
    (pr 256 "merged into chore/no-new-typescript-gate")
    (pr 255 "merged into staging")
    (pr 254 "merged into staging")
    (pr 260 "merged into main"))
  (verification
    "pnpm run check:no-new-typescript -> pass on PR #254 branch"
    "PR #260 production deploy run 26801068165 -> success"
    "https://proxx.promethean.rest/health -> HTTP 200"
    "final residual branch full build not run; docs/receipts/handoff only")
  (guardrails
    "No secret values logged."
    "No destructive cleanup of unrelated worktrees or root workspace dirt."))
