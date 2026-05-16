(fork-tax-state
  (repo "proxx")
  (branch "feat/policy-polish")
  (base "8b47c6921996")
  (timestamp "20260516T185547Z")
  (scope "expect-header-stripping transport-error-cause")
  (verification "git diff --cached --check passed" "pnpm exec tsx --test src/tests/proxy-headers.test.ts passed")
  (residual "auxiliary proxx worktrees left untouched"))
