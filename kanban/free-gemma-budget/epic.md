---
uuid: "f1862673-1b64-48ec-aa4b-f762a820c07a"
title: "Free Gemma with bounded fallback and Orbit visibility"
priority: P1
points: 0
labels: epic, proxx, economy, orbit
---

## Context

The creative cron session accounts for $9.33 of the observed $9.46 Requesty spend. The user selected $0.50/day and $5/month maximum for paid fallback.

## Outcome

A verified free-first bot route with durable paid caps, accurate accounting, model-versus-Lens evaluation and an understandable Orbit dashboard.

## Scope

- [Price and attribute the actual Gemma upstream route](route-cost-accounting.md) (`50568d2c-c150-4954-9e72-0af4a4462580`)
- [Reserve and settle bot paid allowance durably](durable-paid-budget.md) (`70c925ab-42bf-4c79-81d9-5f54e57cf498`)
- [Prefer free Gemma with bounded pre-output fallback](free-first-streaming.md) (`2891facc-c33a-4a19-810d-faa0744fdc4c`)
- [Evaluate E4B separately from Lens integration](knoxx-e4b-evaluation.md) (`7d3dc6c0-af5c-4725-8376-02f7f32befa6`)
- [Expose agent routes budgets and evaluations in Orbit](orbit-economy-dashboard.md) (`1513e0f7-daac-4007-b209-7e626bd1151c`)
- [Deploy economy policy through Services and verify bot route](services-release-verification.md) (`7f6de0c4-8a92-44f3-b9c2-d80c930ca98f`)

- [Qualified Kimi publication](qualified-kimi-publication.md) (`865a672a-f711-4ea6-9b67-33fd1c0cff21`)

## Non-goals

No additional top-up or unbounded paid retries. No replacement Orbit surface.

## Acceptance criteria

Every child acceptance criterion is met; production runs the reviewed source and a real bot request uses the free route.

## Verification

See [release plan](../../specs/drafts/free-gemma-budget-policy.md). Board state transitions are exclusively Rheos operations; these are hand-authored planning inputs with no transition claimed.

## Risks

Slow first usable output, lost usage data, incorrect route pricing and UI/runtime drift. The full plan retains these constraints.
