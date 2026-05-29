---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-dashboard-ui-migration-federation-analytics-md"
title: "Sub-spec: Migrate FederationPage + AnalyticsPage to @open-hax/uxx"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.176Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/dashboard-ui-migration--federation-analytics.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/dashboard-ui-migration--federation-analytics.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/dashboard-ui-migration--federation-analytics.md`

# Sub-spec: Migrate FederationPage + AnalyticsPage to @open-hax/uxx

**Epic:** `dashboard-ui-migration-epic.md`
**SP:** 3
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-ui-migration--dashboard-hosts.md`

## Scope

Migrate the two medium-complexity pages that use tabs, data tables, and status indicators.

### FederationPage.tsx (501 lines → ~300 lines)
Replace:
- Peer status cards → `<Card>` with `<Badge variant="success|warning|error">`
- Peer connection details → `<Card variant="outlined">`
- Tab navigation (peers, bridges, accounts) → `<Tabs variant="enclosed">`
- Sync status indicators → `<Progress indeterminate>` or `<Badge>`
- Action buttons → `<Button variant="primary|secondary|ghost">`

### AnalyticsPage.tsx (448 lines → ~280 lines)
Replace:
- Chart cards → `<Card variant="elevated">`
- Date range selector → `<Input type="date">` or custom with @open-hax/uxx styling
- Metric badges → `<Badge variant="info">`
- Loading states → `<Spinner size="lg">`
- Data tables → styled with @open-hax/uxx tokens

### Changes
- `web/src/pages/FederationPage.tsx` — replace hand-rolled components
- `web/src/pages/AnalyticsPage.tsx` — replace hand-rolled components
- `web/src/styles.css` — remove federation/analytics-specific styles

### Verification
- `pnpm web:build` passes
- Federation page shows peers, bridges, accounts with correct status
- Analytics page renders charts and metric cards correctly
- Tab navigation works in both pages
