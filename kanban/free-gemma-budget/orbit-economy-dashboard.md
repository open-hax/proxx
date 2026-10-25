---
uuid: "1513e0f7-daac-4007-b209-7e626bd1151c"
title: "Expose agent routes budgets and evaluations in Orbit"
priority: P1
points: 5
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
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

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
