---
uuid: "7e9eec3e-43ce-47b1-8318-3295e8d70a5b"
title: "Tenant / Federation / Cloud Roadmap"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.120Z"
source: "kanban/drafts/tenant-federation-cloud-roadmap.md"
category: "specs"
---

> Source: `kanban/drafts/tenant-federation-cloud-roadmap.md`
> Migrated-to-kanban: `kanban/drafts/tenant-federation-cloud-roadmap.md`

# Tenant / Federation / Cloud Roadmap

## Status
Draft

## Summary
Review of current Open Hax specs and recommended sequencing for three next major initiatives:
1. multi-tenancy
2. proxy federation
3. cloud deployment

## What already exists
The current spec set is strong on routing/telemetry foundations, not on platform isolation/distribution:

### Relevant existing specs
- `kanban/drafts/endpoint-agnostic-routing.md`
  - proves the system already abstracts upstream protocol shapes.
- `kanban/drafts/latency-health-routing-v1.md`
  - defines TTFT/TPS/cost-aware routing and observability goals.
- `kanban/drafts/weekly-cost-water-validation.md`
  - pushes durable usage aggregation and explicit coverage semantics.
- `kanban/drafts/provider-model-analytics-page.md`
  - adds operator-facing visibility into provider/model suitability signals.
- `kanban/drafts/dashboard-account-health-provider-filter.md`
  - smaller dashboard UX work.

### What is missing
Originally there were no dedicated specs yet for:
- multi-tenancy
- proxy federation
- hosted/cloud deployment architecture

That gap is now partially closed by the promoted canonical draft:
- `kanban/drafts/open-hax-openai-proxy-multitenancy-user-model.md`

## Current architectural reality
- good for one operator / one trust domain
- not yet safe for shared tenant boundaries
- partially cloud-ready, not fully stateless
- federation-capable in spirit, not yet in protocol

## Recommended order
### 1. Cloud-ready persistence + deployment contract
Do first or in parallel with tenant domain design.
Reason:
- multi-tenancy and federation need durable/shared/cloud-safe state
- current file-backed runtime pieces are a liability in hosted environments

### 2. Multi-tenant foundation
Do before federation data-plane work.
Reason:
- tenant identity and isolation must exist before requests traverse peers
- otherwise federation bakes in the wrong trust and scoping model

### 3. Proxy federation
Do after tenant boundaries and hosted deployment assumptions are explicit.
Reason:
- peers need auth, provenance, loop prevention, and tenant propagation
- all of those depend on the first two efforts

## Companion drafts created
- `kanban/drafts/open-hax-openai-proxy-multitenancy-user-model.md` — canonical tenant + delegated-key + federation identity draft
- `kanban/drafts/cloud-deployment.md`
- `kanban/drafts/multi-tenant-proxy-foundation.md`
- `kanban/drafts/proxy-federation.md`
- `kanban/drafts/federated-tenant-provider-share-policies.md` — policy layer for owned-fleet relay demos, trust tiers, and explicit share modes across tenant DIDs and provider resources

## Proposed immediate next milestone
Start with a narrow “platform foundation” milestone:
- make hosted deployment contract explicit
- inventory/migrate file-backed state to durable stores
- define tenant domain model and default single-tenant migration path

Only after that should we begin actual proxy federation routing.

## Definition of done
- We have explicit drafts for all three tracks.
- We agree on sequencing and dependencies before implementation starts.
