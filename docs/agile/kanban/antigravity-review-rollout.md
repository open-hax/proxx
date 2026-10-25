---
uuid: "48b3efe9-2f52-5cde-8de7-fc59420f8e83"
title: "Adopt the pinned Antigravity reviewer for proxx"
status: incoming
type: chore
priority: P1
points: 2
labels: ci, review, antigravity, hygiene
category: chores
---

## Context

This is an incoming source proposal for `open-hax/proxx`, following
[Foresight rollout planning](https://github.com/open-hax/foresight/pull/145) and
[eta-mu provider planning](https://github.com/open-hax/eta-mu/pull/364). The root planning record is commit
`1f3f7317012e23d7ec0f35a7e22b2b01cdff65b3`. Eta-mu owns reviewer semantics;
Muse provides only organization-local compatibility bytes for Octave Commons.
The checked-in caller records the exact immutable workflow and runtime pins.
The deployed trusted runtime must match that runtime pin; deployment proof is
recorded separately from this incoming planning card.

## Outcome

This repository proposes consuming the shared advisory reviewer with the exact
requested `gemini-3.8-flash-high` model after its existing review and qualification
criteria pass.

## Scope

- `.github/workflows/antigravity-review.yml` is the thin caller proposal.
- This incoming planning document, `receipts.edn`, and
  `.ημ/session-mycology/ledger.md` record local scope and append-only provenance.
- The expected reusable workflow route is `open-hax/eta-mu/.github/workflows/antigravity-code-review.yml`.

## Acceptance criteria

- [ ] Independently verify the caller's exact 40-character workflow pin and runtime
  pin against the reviewed coordinator plan and installed trusted source; the
  runtime pin must be a full immutable commit and model must be exactly
  `gemini-3.8-flash-high`, with no fallback model or mutable reference.
- [ ] Preserve contents/pull-request read-only permissions, exact PR base/head
  binding, and absence of forwarded secrets. The Antigravity process and every
  descendant must receive no GitHub credentials, including read-only tokens.
- [ ] Verify the preinstalled trusted runtime, pinned CLI/Bubblewrap checksums,
  strict read/write/command/MCP-denial profile, finish-only terminal formatting,
  sanitized model environment, complete bounded input and cleanup on every exit.
- [ ] Qualify the organization-local restricted runner group against the exact
  immutable reusable-workflow revision and approved caller repositories before
  activating authenticated persistent workers. Verify mirror byte equality for
  the Octave Commons route.
- [ ] Run this repository's existing required checks and obtain fresh exact-head
  review. Preserve package-manager, application, branch-protection and approval
  policies; imported CLI artifacts grant no native approval or merge credit.
- [ ] Observe a real hosted execution with the selected model and inspect exact
  revision/diff binding, complete scope, retained native output, and failure
  behavior. Worker unavailability or missing authentication remains unavailable.

## Verification

Run `actionlint .github/workflows/antigravity-review.yml` and `git diff --check "$PR_BASE_SHA" "$PR_HEAD_SHA"`,
then the root rollout tool's exact mapped `check` documented in
[Foresight rollout notes](https://github.com/open-hax/foresight/blob/0762e0d749c6bb6f2e76cf1611e1f63366e14801/docs/notes/antigravity-review-rollout.md).
Those local source checks do not establish hosted runner or model availability.
Existing deterministic repository checks and required review remain necessary.

## Status and non-goals

This document remains **incoming**. It is hand-authored planning input, with no
Rheos admission, transition, write-id or engine event asserted. Shared worker
registration has been observed; this repository's final source adoption,
exact-head review/CI and hosted qualification remain pending. No merge, deployment, credential copying, branch-policy change,
new board engine, or application/runtime implementation is authorized here.


## Caller review acceptance supplement (2026-10-25)

- Verify opened, synchronize, reopened, ready_for_review and base-retarget events
  share the per-PR review group. Title/body edits use distinct run groups.
- Verify converted_to_draft cancels that group and skips model execution.
- Verify fork or missing-repository heads skip before reusable-workflow admission.
- Before giving an artifact qualification credit, compare its recorded base and
  head to the live PR. Base advances require a fresh review; this caller does not
  automatically dispatch on base-branch pushes. Existing merge-candidate and
  deterministic gates remain required; a green historical check is insufficient.
