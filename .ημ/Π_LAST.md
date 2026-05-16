# Π Fork Tax Snapshot — proxx

- Timestamp: 20260516T185547Z
- Branch: feat/policy-polish
- Base: 8b47c6921996
- Scope: large request transport header hardening.

## Included work

- Stripped `Expect` from forwarded upstream request headers.
- Preserved transport error cause details for provider routing logs/events.
- Added regression assertion for `expect` header stripping.
- Recorded recursive fork-tax receipts and manifest artifacts.

## Verification

- `git diff --cached --check` passed.
- `pnpm exec tsx --test src/tests/proxy-headers.test.ts` passed.

## Residual dirt

- Proxx auxiliary worktrees under `.worktrees/` remain separate branch scopes and were left untouched.
