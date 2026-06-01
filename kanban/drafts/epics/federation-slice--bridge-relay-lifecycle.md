---
uuid: "6f931eec-d345-422b-a7ad-ab659e61c859"
title: "Sub-spec: Bridge relay lifecycle extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.138Z"
source: "kanban/drafts/epics/federation-slice--bridge-relay-lifecycle.md"
category: "specs"
---

> Source: `kanban/drafts/epics/federation-slice--bridge-relay-lifecycle.md`
> Migrated-to-kanban: `kanban/drafts/epics/federation-slice--bridge-relay-lifecycle.md`

# Sub-spec: Bridge relay lifecycle extraction

**Epic:** `federation-slice-epic.md`
**SP:** 3
**Priority:** P1
**Depends on:** `control-plane-api-contract-v1.md`

## Scope
Move bridge relay creation, WebSocket upgrade authorization, and lifecycle wiring out of `src/lib/ui-routes.ts` into the composition root and dedicated federation modules.

### Changes
1. Move `registerFederationUiRoutes` bridge WebSocket handler to a dedicated `src/lib/federation/bridge-route.ts` module
2. Register `/api/v1/federation/bridge/ws` (canonical) alongside `/api/ui/federation/bridge/ws` (legacy alias)
3. Move bridge relay construction from `ui-routes.ts` return value to `app.ts` composition root
4. Ensure `bridgeRelay` is available to both data-plane and control-plane via `AppDeps`

### Affected files
- `src/lib/ui-routes.ts` — remove bridge relay construction and WS handler
- `src/lib/federation/bridge-route.ts` — new: WS upgrade handler
- `src/app.ts` — construct bridge relay, pass to route registration
- `src/routes/federation/ui.ts` — register canonical WS endpoint

## Verification
- `pnpm build` passes
- WebSocket upgrade at `/api/v1/federation/bridge/ws` works
- Bridge relay is accessible to federation route handlers
- `ui-routes.ts` no longer imports bridge relay types
