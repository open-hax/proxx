---
uuid: "7f6de0c4-8a92-44f3-b9c2-d80c930ca98f"
title: "Deploy economy policy through Services and verify bot route"
priority: P1
points: 3
labels: proxx, economy, gemma
epic: "f1862673-1b64-48ec-aa4b-f762a820c07a"
parent: "f1862673-1b64-48ec-aa4b-f762a820c07a"
dependency: 865a672a-f711-4ea6-9b67-33fd1c0cff21, 50568d2c-c150-4954-9e72-0af4a4462580, 70c925ab-42bf-4c79-81d9-5f54e57cf498, 2891facc-c33a-4a19-810d-faa0744fdc4c, 7d3dc6c0-af5c-4725-8376-02f7f32befa6, 1513e0f7-daac-4007-b209-7e626bd1151c
---

## Context

Part of the free Gemma and budgeted fallback release. See [release plan](../../specs/drafts/free-gemma-budget-policy.md).

## Outcome

Deploy economy policy through Services and verify bot route.

## Scope

Reviewed release through Services with image/source, compiled policy/pricing/budget canaries and real inference.

## Non-goals

No extra top-up, consumer OAuth proxy, public evaluation posts, or replacement dashboard.

## Acceptance criteria

Production image/source matches reviewed revision; real bot request demonstrably uses free Google route. Paid cap tests use fixtures, without real over-budget charges. Orbit displays verified runtime data.

Deployed-build acceptance: compiled route/pricing/budget canaries pass. Synthetic fixtures admit when spent plus reserved plus the proposed request is below or exactly equal to both caps; crossing either cap denies admission. An already-full cap denies any positive reservation. Exercise both daily and monthly boundaries without real over-budget inference charges.

## Verification

Relevant unit/integration tests, compiled runtime checks and retained evidence in workspace receipts. Release story additionally requires production and real bot inference evidence.

## Risks

Route alias collapse, incomplete usage, thinking-only streams, shared credentials, concurrency and stale mounted contracts can invalidate apparent success. Fail closed and expose uncertainty.
