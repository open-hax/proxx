(fork-tax-state
  (timestamp "2026-06-02T02:45:52Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx")
  (branch "docs/clade-docs-reports")
  (base "origin/staging")
  (intent "Preserve local Proxx dirt, remove generated jscpd reports from PR #255, and prepare the outstanding PR merge campaign.")
  (owned-paths
    ".gitignore"
    "DEVEL.md"
    "receipts.edn"
    "reports/jscpd/** (removed)"
    ".ημ/Π_LAST.md"
    ".ημ/Π_STATE.sexp"
    ".ημ/Π_MANIFEST.sha256")
  (verification
    "git diff --check -> pass"
    "full build not run; docs/receipts/generated-artifact cleanup only")
  (concurrent-guardrails
    "No repo-wide reset/restore/clean used."
    "Unrelated root workspace and other worktrees left untouched."))
