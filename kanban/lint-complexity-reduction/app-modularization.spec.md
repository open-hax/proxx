---
uuid: "inbox-worktrees-proxx-pr-156-coderabbit-kanban-inbox-worktrees-proxx-pr-156-coderabbit-specs-lint-complexity-reduction-app-modularization-spec-md"
title: "Spec: App Modularization"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.112Z"
source: "inbox/worktrees/proxx-pr-156-coderabbit/specs/lint-complexity-reduction/app-modularization.spec.md"
category: "specs"
---

> Source: `inbox/worktrees/proxx-pr-156-coderabbit/specs/lint-complexity-reduction/app-modularization.spec.md`
> Migrated-to-kanban: `inbox/worktrees/proxx-pr-156-coderabbit/kanban/lint-complexity-reduction/app-modularization.spec.md`

# Spec: App Modularization

**Status:** OBSOLETE — superseded by `specs/drafts/control-plane-mvc-transition-roadmap.md` and `specs/drafts/control-plane-api-contract-v1.md`

## Historical Reference
Original goal: Split `src/app.ts` from 2337 lines into routes/, handlers/, middleware/.

## Resolution
The MVC transition roadmap and control-plane contract spec achieved the same goals through a different approach:
- Route modules extracted to `src/routes/`
- `registerApiV1Routes` for canonical control-plane routes
- `ui-routes.ts` deleted entirely
- `app.ts` reduced from 1025 → 896 lines

See `specs/drafts/control-plane-mvc-transition-roadmap.md` for the authoritative roadmap.
