# Sub-spec: Data table shell with sticky header + scroll region

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 5
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-patterns-to-ui--surface-hero.md`

## Problem

The dashboard repeats a heavy table pattern in several places:
- `AnalyticsPage` model/provider/pair tables
- `HostsPage` route/container tables
- `DashboardPage` request log + account tables
- `CredentialsPage` quota/prompt cache tables

Pattern:
- sticky header
- horizontal scroll wrapper
- dense numeric columns
- optional wide mode
- optional empty state / loading state

## Scope

Add a shared `DataTableShell` component:
```tsx
<DataTableShell
  columns={[...]}
  rows={rows}
  wide
  loading={loading}
  emptyState="No rows"
  renderCell={(row, column) => ...}
/>
```

Required features:
- sticky header
- scroll region container
- dense and wide modes
- empty state
- loading overlay/state
- custom cell renderer

## Target files
- `packages/ui/contracts/data-table-shell.edn`
- `packages/ui/react/src/primitives/DataTableShell.tsx`
- stories for compact/wide/loading/empty modes

## First adopters in proxx
- `web/src/pages/AnalyticsPage.tsx`
- `web/src/pages/HostsPage.tsx`

## Verification
- sticky header behavior preserved
- browser smoke still passes on analytics/hosts pages
- old `analytics-table*` and `hosts-table*` CSS reduces substantially
