(fork-tax-state
  (timestamp "2026-05-29T22:07:06Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx/.worktrees/proxx-policy-requested-provider-facts-20260529T215446Z")
  (branch "pi/proxx-policy-requested-provider-facts-20260529T215446Z")
  (base "origin/chores/policy-driven-embeddings")
  (intent "Fix Proxx declarative policy requested-provider facts for embeddings while preserving services/proxx/policies and resources/policies as distinct policy trees.")
  (owned-paths
    "receipts.edn"
    "src/proxx/policy/contracts.cljs"
    "src/lib/provider-routing.ts"
    "src/routes/embeddings.ts"
    "src/routes/native-ollama.ts"
    "src/tests/cljs-policy-preview.test.ts"
    "test/proxx/policy_test.cljs"
    ".ημ/Π_STATE.sexp"
    ".ημ/Π_LAST.md"
    ".ημ/Π_MANIFEST.sha256")
  (verification
    "pnpm test:cljs -> 113 tests/302 assertions, 0 failures/errors; 8 pre-existing infer warnings"
    "pnpm test -> 641 tests, 639 pass, 2 skipped, 0 fail"
    "pnpm test:coverage -> 641 tests, 639 pass, 2 skipped, 0 fail; all files lines 81.77%, branches 72.94%, funcs 78.45%"
    "touched TS eslint --quiet -> pass"
    "git diff --check -> pass")
  (policy-boundary
    "No services/proxx/policies EDN edited."
    "No orgs/open-hax/proxx/resources/policies EDN edited."
    "Tests assert CLJS interpreter behavior and requested-provider facts rather than hard-coding a TypeScript policy detour."
    "Requested-provider route assertions avoid depending on optional provider-route path metadata."))
