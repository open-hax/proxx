---
uuid: "inbox-worktrees-proxx-pr-156-coderabbit-kanban-inbox-worktrees-proxx-pr-156-coderabbit-specs-lint-complexity-reduction-ui-routes-flattening-spec-md"
title: "Spec: `ui-routes.ts` Monolith Deprecation and Surface Migration"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.117Z"
source: "inbox/worktrees/proxx-pr-156-coderabbit/specs/lint-complexity-reduction/ui-routes-flattening.spec.md"
category: "specs"
---

> Source: `inbox/worktrees/proxx-pr-156-coderabbit/specs/lint-complexity-reduction/ui-routes-flattening.spec.md`
> Migrated-to-kanban: `inbox/worktrees/proxx-pr-156-coderabbit/kanban/lint-complexity-reduction/ui-routes-flattening.spec.md`

# Spec: `ui-routes.ts` Monolith Deprecation and Surface Migration

**Status:** OBSOLETE — `src/lib/ui-routes.ts` has been deleted entirely. All routes now register via `registerApiV1Routes` + `registerWebSocketRoutes` in `app.ts`.

## Historical Reference
Original goal: Extract route handlers from the 2900-line `ui-routes.ts` monolith into `src/routes/` modules.

## Resolution
- `ui-routes.ts` deleted (was 62 lines at time of deletion)
- All routes register through `registerApiV1Routes` (HTTP) and `registerWebSocketRoutes` (WS)
- All test URLs migrated from `/api/ui/*` to `/api/v1/*`
- Deprecation headers added to remaining `/api/ui/*` routes

See `specs/drafts/epics/contract-deprecation-epic.md` for the authoritative tracker.
