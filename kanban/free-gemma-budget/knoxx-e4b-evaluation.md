---
uuid: "7d3dc6c0-af5c-4725-8376-02f7f32befa6"
title: "Evaluate E4B separately from Lens integration"
priority: P1
points: 5
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Evaluate E4B separately from Lens integration.

## Scope

Read loaded local agent contracts and compare safe matched tasks under E4B and 31B; isolate Lens context effects.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

Report grounding, tool choice, hallucination, instruction following, first visible latency and throughput. No outbound public posts. Preserve unrelated dirty source and live sessions.

Experiment acceptance: the release plan fixes eight safe tasks, two models, two paired context conditions, three repetitions (96calls),256-token output cap, fixture-specific0/1/2 scoring and manual failure adjudication. Estimate raised to5points for fixture preparation and execution.

Adoption acceptance: E4B has zero fixture-safety or tool-boundary violations and its grounded/instruction/tool aggregate is at least the matched31B score on the fixtures relevant to each contract. Otherwise explicitly record keep31B for that contract; collecting a failed experiment alone never authorizes E4B adoption.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
