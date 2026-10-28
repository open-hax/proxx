---
uuid: "865a672a-f711-4ea6-9b67-33fd1c0cff21"
title: "Consume the qualified Kimi publication workflow for this release"
priority: P1
points: 2
labels: proxx, review, reliability
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
---

## Context

This branch inherits a Kimi workflow using an unsupported model identifier. Restoration PR445 at aba0697 contains the workflow source already recognized by the canonical publication admission profile. The pinned runtime2810f4515424a146fe37390fb0baf532cca31236 is already an ancestor of this branch. The old PR445 native review references producer attempt1 while its currently retained artifact belongs to attempt2; that is not a current qualifying proof.

## Outcome

This release can obtain fresh native Kimi coverage without merging or changing the separate PR445.

## Scope

Consume the exact workflow bytes, its reviewed regression tests, and the reviewed comment-command trigger isolation from PR445. Preserve the pinned runtime, auth helper, immutable source checks, separate producer/publisher credentials, full-diff validation and canonical admission rules.

## Non-goals

No review-policy relaxation, identity substitution, fabricated artifact or manual approval. Do not rewrite the old PR445 publication or claim its current proof admitted.

## Acceptance criteria

The workflow SHA256 remains90117459b8c0a6883b27df816127fdd3bcb4799e5e25e52f356d04ac134f68bb. Regression tests pass. A fresh native run on this PR head emits an unexpired producer artifact and matching publisher/readback provenance, and canonical admission independently verifies its source, head and full-diff binding. A successful workflow alone does not satisfy review approval.

## Verification

Run node --test .github/scripts/kimi-review.test.cjs, inspect the native run and artifact, then use canonical pr-flow status/gate for current-head admission.

## Risks

Same-head re-production can reuse an older submission whose original producer artifact is no longer retained. Such a review remains unqualified; never bind it to a different producer manually. The new source consumption commit creates a genuinely changed head, not an empty review trigger.
