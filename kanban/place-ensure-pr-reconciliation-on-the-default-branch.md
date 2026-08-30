---
category: "kanban"
labels: "automation, ci, maintenance, containment"
type: "task"
write-id: "1788061343686-0.2fq52lwgjnab3q3byt2"
points: "2"
title: "Place ensure-PR reconciliation on the default branch"
priority: "P1"
status: "breakdown"
uuid: "place-ensure-pr-reconciliation-on-the-default-branch"
created_at: "2026-08-30T03:40:25.985Z"
---

## Objective

Make the Proxx ensure-PR reconciliation workflow callable on demand and by its declared schedule from the repository default branch, so automation containment can be verified without manufacturing branch-create events.

## Exact evidence

- Proxx default branch `main` returns 404 for `.github/workflows/ensure-pr-to-staging.yml`.
- Exact `staging@10a7d2303490127de38afa4d6a17ef8e2670874d` contains the workflow as blob `7a20cc1f7406011a87ec4df3c93e6ff531a8cdef` with `schedule`, `workflow_dispatch`, and `create` triggers.
- GitHub documents that scheduled workflows run only on the default branch and `workflow_dispatch` receives events only when the workflow file exists on the default branch.
- The inert triggers forced containment verification through a temporary zero-ahead branch-create event. Run `33290703029`, job `99201708735`, proved eta activation `285fedac4cebc82844bd2e1e21ff87210ee8c2b2` executing repaired pin `9f075501ba3b1fae3e6a8865d39f2fea7d11c1dc`, with `created: []` and `errors: []`.

## Acceptance criteria

- A reviewed workflow entry point exists on the default branch and can dispatch the canonical ensure-PR reconciliation without changing the repository staging base.
- Both the declared schedule and a bounded manual dispatch produce observable runs without requiring a synthetic branch or tag event.
- A regression or exact hosted receipt proves unchanged terminal heads and `ahead_by=0` branches do not recreate pull requests.
- The implementation preserves immutable eta execution evidence and does not weaken PR review, branch protection, or merge-method policy.
- The temporary audit branch is removed through an authenticated exact-SHA guard once its already-terminal evidence has been retained.

## Constraints

- This is separate from issue #434 / card PR #435, which owns the eta SQUASH request versus Proxx merge-method mismatch.
- Do not bulk-close the remaining quarantine PRs until the activated suppression behavior and temporary-ref cleanup are both reconciled.
- Do not change default branch, staging policy, repository settings, or authentication as an implicit workaround.

---
Canonical GitHub projection created as issue #436 after exact title and marker searches returned no match. The issue preserves this card identifier, breakdown status, P1 priority, exact workflow/blob/run evidence, and separate scope from #434/#435. The card remains canonical; implementation and temporary-ref cleanup require reviewed, authenticated follow-through.

Explicit cleanup ownership: this task owns deletion of exactly audit/eta-terminal-suppression-20260830t033746z at 10a7d2303490127de38afa4d6a17ef8e2670874d once an authenticated delete-ref surface is available. Deletion must require that exact remote SHA and be followed by an independent absence check; no other ref is in scope. Until then the stranded zero-ahead ref is preserved as known operational debt, not treated as an open pull request.
---