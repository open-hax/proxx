;; Π State Snapshot
;; Generated: 2026-04-02T18:45:15Z

(
  :repo "open-hax/proxx"
  :branch "fork-tax/20260330-205903-aco-route-quota-cooldowns"
  :previous-tag "Π/20260330-205903-aco-route-quota-cooldowns"
  :intended-tag "Π/20260402-184515-migration-pipeline-routing-cleanup"
  :remote "origin"

  :work-description
  "Audit and remediation: migration pipeline hardening + ad-hoc routing code cleanup.

  Triggered by proxx container crash (missing 'disabled' column — migration v7 was
  recorded but not applied because runMigrations() hardcoded SQL instead of iterating
  ALL_MIGRATIONS).

  Changes:
  - Refactored runMigrations() to iterate ALL_MIGRATIONS (single source of truth)
  - Added schema-migration.test.ts with 5 consistency tests
  - Deleted 2 dead code files (model-selection-policies.ts, provider-route-policies.ts)
  - Created fastify-types.ts augmentation, removed 55 ad-hoc openHaxAuth casts
  - Created model-family.ts registry (replaces 3 scattered implementations)
  - Extracted routing-outcome-handler.ts (215 lines eliminated from route handlers)
  - Batched ~20 inline OPTIONS handlers in app.ts
  - MCP endpoint status corrected from 'implemented' to 'planned'
  - Full audit report + 6 remediation specs written"

  :verification (
    :build "pass (tsc -p tsconfig.json — zero errors)"
    :tests "pass (10/10: schema-migration + model-routing-helpers)"))

  :deferred (
    :token-refresh-extraction "Needs live OAuth testing; 90 lines in app.ts"
    :deps-unification "AppDeps vs UiRouteDependencies — needs dedicated session"))
