---
uuid: "50568d2c-c150-4954-9e72-0af4a4462580"
title: "Price and attribute the actual Gemma upstream route"
priority: P1
points: 3
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Price and attribute the actual Gemma upstream route.

## Scope

Provider-specific EDN prices and actual upstream model attribution; retain requested alias separately.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

Compiled manifest distinguishes zero-cost Google from 0.13/0.38 per-million DeepInfra. Forced pricing works without catalog coverage. Unknown price is distinct from free.

Identity acceptance: a requested alias resolving to a different upstream model retains both identities, computes billing from the actual upstream route, and preserves those identities and prices through journal reload, SQL readback and derived-estimate refresh.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
