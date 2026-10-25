---
uuid: "70c925ab-42bf-4c79-81d9-5f54e57cf498"
title: "Reserve and settle bot paid allowance durably"
priority: P1
points: 5
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
dependency: 50568d2c-c150-4954-9e72-0af4a4462580
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Reserve and settle bot paid allowance durably.

## Scope

SQL reservation adapter with EDN ceilings interpreted in CLJS. Both UTC daily 0.50 USD and monthly 5 USD caps apply to spent plus reserved.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

Concurrent requests and process restarts cannot overspend either cap. Missing usage retains conservative reservation. Free/local work stays outside the paid allowance.

Calendar acceptance: admission-date charge ownership, unresolved carryover against both current caps, late settlement, midnight/month rollover and restart cases follow the release plan.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
