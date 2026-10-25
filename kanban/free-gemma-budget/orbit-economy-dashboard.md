---
uuid: "1513e0f7-daac-4007-b209-7e626bd1151c"
title: "Expose agent routes budgets and evaluations in Orbit"
priority: P1
points: 5
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
dependency: 50568d2c-c150-4954-9e72-0af4a4462580, 70c925ab-42bf-4c79-81d9-5f54e57cf498, 7d3dc6c0-af5c-4725-8376-02f7f32befa6
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Expose agent routes budgets and evaluations in Orbit.

## Scope

Extend authenticated constellation dashboard and metadata adapters.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

Show agent and contract identity, free/paid route use, actual versus estimated/unpriced cost, daily/monthly spent/reserved/remaining and UTC resets, latency distributions and evaluation evidence. No credentials or private prompts reach UI.

Rollover display acceptance: show current-period actual spend, current reservations, and carried unresolved reservations as separate values for each cap. Remaining allowance subtracts all three; do not hide conservative old holds inside a single reserved total.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
