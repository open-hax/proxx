---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-federation-slice-advanced-routes-md"
title: "Sub-spec: Advanced federation route extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.180Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/federation-slice--advanced-routes.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/federation-slice--advanced-routes.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/federation-slice--advanced-routes.md`

# Sub-spec: Advanced federation route extraction

**Epic:** `federation-slice-epic.md`
**SP:** 3
**Priority:** P1
**Depends on:** `control-plane-api-contract-v1.md`

## Scope
Extract the remaining federation routes from `src/lib/ui-routes.ts` into `src/routes/federation/ui.ts` with the canonical prefix.

### Routes to extract
- `projected-accounts/routed` — list routed projected accounts
- `projected-accounts/imported` — list imported projected accounts
- `projected-accounts/import-all` — bulk import projected accounts
- `usage-export` — export federation usage data
- `usage-import` — import federation usage data
- `sync/pull` — pull federation sync from a peer

### Changes
1. Move handler logic from `ui-routes.ts` into `src/routes/federation/ui.ts`
2. Register under both `/api/v1/federation/*` (canonical) and `/api/ui/federation/*` (legacy alias)
3. Extract any inline store orchestration into thin service functions
4. Update `web/src/lib/api.ts` to use `/api/v1/federation/sync/pull`

## Verification
- `pnpm build` passes
- All 6 routes respond at both `/api/v1/federation/*` and `/api/ui/federation/*`
- Existing federation tests pass
