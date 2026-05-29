---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-dashboard-patterns-to-ui-data-table-shell-md"
title: "Sub-spec: Data table shell with sticky header + scroll region"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.183Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/dashboard-patterns-to-ui--data-table-shell.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/dashboard-patterns-to-ui--data-table-shell.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/dashboard-patterns-to-ui--data-table-shell.md`

# Sub-spec: Data table shell with sticky header + scroll region

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 5
**Priority:** P2
**Status:** ✅ Done
**Depends on:** `dashboard-patterns-to-ui--surface-hero.md`

## Result
- `DataTableShell` implemented in `orgs/open-hax/uxx/react/src/primitives/DataTableShell.tsx`
- contract added: `orgs/open-hax/uxx/contracts/data-table-shell.edn`
- adopted in `web/src/pages/AnalyticsPage.tsx` (models, providers, pairs tables)
- column definitions moved to module scope for stable references
- replaced 3 inline `<table>` definitions with typed `DataTableColumn<AnalyticsRow>[]` configs

## Features implemented
- sticky header (default, configurable)
- horizontal scroll wrapper
- wide mode (min-width for wide tables)
- dense mode (reduced padding)
- empty state rendering
- loading overlay with Spinner
- custom cell renderer per column
- column-level width and alignment control

## Verification
- `npm run build` in `orgs/open-hax/uxx/react` passes
- `pnpm web:build` in `orgs/open-hax/proxx` passes
- `pnpm web:test` in `orgs/open-hax/proxx` passes
- AnalyticsPage builds and renders all three table views
