---
category: "tasks"
labels: "ci, automation, governance"
type: "task"
write-id: "1788059023517-0.6i8zt9ne3hdsmzd4q4"
title: "Align auto-merge method with repository policy"
priority: "P2"
status: "breakdown"
uuid: "a3d9bff6-99d9-433d-adff-9889ada46f7a"
created_at: "2026-08-30T03:00:46.626Z"
---

## Problem

Proxx's caller workflow requests `merge-method: SQUASH`, while the repository currently allows merge commits only. As a result, the reusable eta-mu auto-merge job fails instead of enabling auto-merge on otherwise eligible pull requests.

## Exact evidence

- Observed on PR #433 at immutable head `4dcde813e67ba8e79a0098f687579b7ef5c715eb`.
- Failed workflow run: `33289033074`; failed job: `99197267148`.
- The caller at `.github/workflows/auto-merge.yml` passes `merge-method: SQUASH`.
- The job records input `merge-method: SQUASH`, invokes auto-merge for `open-hax/proxx#433`, and terminates with `Merge method squash merging is not allowed on this repository`.
- Authoritative repository metadata at intake reports `allow_merge_commit: true`, `allow_squash_merge: false`, `allow_rebase_merge: false`, and `allow_auto_merge: true`.

## Scope

Align Proxx's auto-merge caller with the repository's allowed merge-method policy. This is a standalone CI-governance repair; it must not be folded into PR #433 or deployment-authority issue #356.

## Acceptance criteria

- Re-read authoritative repository merge-method metadata immediately before implementation.
- Make the caller request an allowed method; with the current policy, that is `MERGE`.
- Do not change repository settings to enable squash, bypass protected checks, manually enable auto-merge, or weaken review requirements.
- Add a focused contract/regression check that rejects a configured method not allowed by repository policy and accepts the selected allowed method.
- A controlled exact-head pull-request run reaches the intended auto-merge pending/enabled state without the method-policy error.
- Preserve the failed run/job and exact PR head above as the causal evidence.

## Non-goals

- No deployment workflow or authority changes.
- No changes to PR #433's tree.
- No general eta-mu rollout or quarantine cleanup.

---
Canonical GitHub projection created as issue #434 after exact UUID/title and method-error duplicate searches returned no match. The issue preserves failed run 33289033074 / job 99197267148, PR #433 exact head 4dcde813e67ba8e79a0098f687579b7ef5c715eb, authoritative merge-policy metadata, breakdown status, P2 priority, and the standalone scope boundary. No PR #433 or deployment-authority files were changed.

Standalone card-projection PR #435 was published at exact head 3e04f84a474c2a6925be7139bfc56a613dfbfa27, base 10a7d2303490127de38afa4d6a17ef8e2670874d, tree 928dac0ecf0a1ba0ccd1c814cc75ea923c0fa292. It changes only this card and the append-only Rheos ledger; issue #434 remains open because no workflow implementation is included.
---