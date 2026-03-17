# Π Snapshot — 2026-03-17T15:52:30Z

- Repo: `open-hax-openai-proxy`
- Branch: `main`
- Remote: `origin/main`
- Base HEAD at capture start: `b6c18a0`
- Previous Π commit: `b6c18a0`
- Working tree at capture start: dirty

## What changed
- Persist upstream error summary fields and sanitized Factory 4xx diagnostics in request logs.
- Record hashed/prompt-shape Factory diagnostics so prompt rejections are debuggable without storing raw prompt text.
- Add regression coverage for Factory diagnostics persistence and request-log reload behavior.
- Track the work in specs/drafts/factory-4xx-diagnostics.md and receipts.log.

## Files to inspect
- `receipts.log`
- `src/lib/provider-strategy.ts`
- `src/lib/request-log-store.ts`
- `src/tests/factory-strategy.test.ts`
- `src/tests/request-log-store.test.ts`
- `specs/drafts/factory-4xx-diagnostics.md`

## Verification
- pass: pnpm run build
- pass: pnpm test (253/253)

## Open questions
- Should the sanitized Factory diagnostic shape later be generalized beyond Factory 4xx responses?

## Notes
- Artifacts capture the pre-snapshot base head; the final Π commit/tag are created after artifact assembly.
- Push is attempted after the snapshot commit is created; final push status is reported via git/assistant output.
