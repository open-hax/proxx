(fork-tax-state
  (timestamp "2026-05-29T22:49:00Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx/.worktrees/proxx-policy-requested-provider-facts-20260529T215446Z")
  (branch "pi/proxx-policy-requested-provider-facts-20260529T215446Z")
  (base "origin/chores/policy-driven-embeddings")
  (intent "Fix Proxx declarative policy requested-provider facts for embeddings and address CodeRabbit PR #215 review findings.")
  (owned-paths
    "receipts.edn"
    "src/proxx/policy/contracts.cljs"
    "src/lib/provider-routing.ts"
    "src/routes/embeddings.ts"
    "src/routes/native-ollama.ts"
    "src/tests/cljs-policy-preview.test.ts"
    "src/tests/proxy.test.ts"
    "test/proxx/policy_test.cljs"
    ".ημ/Π_STATE.sexp"
    ".ημ/Π_LAST.md"
    ".ημ/Π_MANIFEST.sha256")
  (coderabbit
    (pr "https://github.com/open-hax/proxx/pull/215")
    (review "manual @coderabbitai review triggered")
    (findings-addressed
      "preserve exact explicit Ollama provider prefix for embeddings requestedProviderIds"
      "prefer native ollama prefix for unprefixed native /api/embed bridge requests instead of config order"))
  (verification
    "targeted tsx proxy tests -> 4 pass"
    "pnpm test -> 643 tests, 641 pass, 2 skipped, 0 fail"
    "pnpm test:coverage -> 643 tests, 641 pass, 2 skipped, 0 fail; all files lines 81.77%, branches 72.87%, funcs 78.45%"
    "pnpm test:cljs -> 113 tests/302 assertions, 0 failures/errors; 8 pre-existing infer warnings"
    "touched TS eslint --quiet -> pass"
    "git diff --check -> pass")
  (policy-boundary
    "No services/proxx/policies EDN edited."
    "No orgs/open-hax/proxx/resources/policies EDN edited."
    "Tests assert CLJS interpreter behavior and requested-provider facts rather than hard-coding a TypeScript policy detour."))
