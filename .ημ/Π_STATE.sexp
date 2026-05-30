(fork-tax-state
  (timestamp "2026-05-30T01:16:12Z")
  (repo "/home/err/devel/orgs/open-hax/proxx")
  (worktree "/home/err/devel/orgs/open-hax/proxx/.worktrees/proxx-pr215-into-staging-20260530T004530Z")
  (branch "pi/proxx-pr215-into-staging-20260530T004530Z")
  (base "origin/staging@6a132ef")
  (intent "Merge PR #215 requested-provider policy runtime fixes into staging after the original intermediate base branch was merged without PR #215.")
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
  (source-pr
    (url "https://github.com/open-hax/proxx/pull/215")
    (commits "5f8d3f0" "5cf6280")
    (status "closed before staging received these commits; cherry-picked onto fresh staging branch"))
  (verification
    "pnpm install --frozen-lockfile -> pass"
    "pnpm test:cljs -> 113 tests/302 assertions, 0 failures/errors; 8 pre-existing infer warnings"
    "pnpm build:cljs -> pass"
    "targeted tsx proxy tests -> 4 pass"
    "pnpm test -> 643 tests, 641 pass, 2 skipped, 0 fail"
    "pnpm test:coverage -> 643 tests, 641 pass, 2 skipped, 0 fail; all files lines 81.81%, branches 73.01%, funcs 78.53%"
    "touched TS eslint --quiet -> pass"
    "git diff --check -> pass")
  (policy-boundary
    "No services/proxx/policies EDN edited."
    "No orgs/open-hax/proxx/resources/policies EDN edited."
    "Tests assert CLJS interpreter behavior and requested-provider facts rather than preserving the staging TypeScript explicit-provider filter."))
