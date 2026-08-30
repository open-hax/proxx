(fork-tax-state
  (timestamp "2026-06-03T20:14:11Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx")
  (branch "devops/promethean-service-module-deploy")
  (base "origin/staging")
  (intent "Absorb the defaults policy-tree README (three-policy-trees doctrine: defaults vs local peer vs Promethean relay) and promote the branch into staging via PR.")
  (owned-paths
    "resources/policies/README.md"
    ".ημ/Π_LAST.md"
    ".ημ/Π_STATE.sexp"
    ".ημ/Π_MANIFEST.sha256"
    ".ημ/registry.jsonl")
  (state
    "deploy-module commit 74b8b85 already merged into origin/staging as 0269ada"
    "relay policy tree preserved in open-hax/services Π/20260603T201215Z (contracts/proxx/policies)")
  (verification
    "README-referenced policy files exist: runtime/60-tenant-enforcement.edn, runtime/65-federation-routing.edn"
    "docs-only change; CI gates (staging-typecheck, staging-unit-tests) run on the PR")
  (deployment
    "completed: PR devops/promethean-service-module-deploy -> staging"
    "retired: shared testing and staging host mutation paths"
    "production authority: open-hax/services declared DigitalOcean contract")
  (concurrent-dirt-left-untouched)
  (guardrails
    "Path-scoped staging; no repo-wide reset/restore/clean."
    "No secrets logged."))
