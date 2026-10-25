---
uuid: "2891facc-c33a-4a19-810d-faa0744fdc4c"
title: "Prefer free Gemma with bounded pre-output fallback"
priority: P1
points: 5
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
dependency: 70c925ab-42bf-4c79-81d9-5f54e57cf498
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Prefer free Gemma with bounded pre-output fallback.

## Scope

Ordered same-provider upstream models from EDN, CLJS plan interpreter, transport deadline before downstream commitment.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

A slow free response falls back before committing visible output. Affinity cannot promote paid routes. Every paid attempt has a reservation; fallback denial remains an explicit exhausted result.

Timing acceptance: free cutoff12seconds; total first usable deadline20seconds from admission including queue time; reasoning/headers/partial tools do not qualify. Fake-clock cases and terminal behavior follow the release plan.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
