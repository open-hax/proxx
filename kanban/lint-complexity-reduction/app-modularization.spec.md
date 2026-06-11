---
uuid: "313d190d-6c5e-4b3f-bae6-0f63f710a933"
title: "Spec: App Modularization"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.112Z"
source: "kanban/lint-complexity-reduction/app-modularization.spec.md"
category: "specs"
---

> Source: `kanban/lint-complexity-reduction/app-modularization.spec.md`
> Migrated-to-kanban: `kanban/lint-complexity-reduction/app-modularization.spec.md`

# Spec: App Modularization

**Status:** OBSOLETE — superseded by `kanban/drafts/control-plane-mvc-transition-roadmap.md` and `kanban/drafts/control-plane-api-contract-v1.md`

## Historical Reference
Original goal: Split `src/app.ts` from 2337 lines into routes/, handlers/, middleware/.

## Resolution
The MVC transition roadmap and control-plane contract spec achieved the same goals through a different approach:
- Route modules extracted to `src/routes/`
- `registerApiV1Routes` for canonical control-plane routes
- `ui-routes.ts` deleted entirely
- `app.ts` reduced from 1025 → 896 lines

See `kanban/drafts/control-plane-mvc-transition-roadmap.md` for the authoritative roadmap.
