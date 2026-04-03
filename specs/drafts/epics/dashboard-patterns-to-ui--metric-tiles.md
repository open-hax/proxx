# Sub-spec: Metric tile grid + stat card components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 3
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-patterns-to-ui--surface-hero.md`

## Problem

Metric/summary tiles recur across the dashboard:
- `DashboardPage` metrics grid
- `AnalyticsPage` summary cards
- `HostsPage` host stats summaries

Pattern:
- label
- prominent numeric value
- optional secondary text
- optional loading state
- optional status/variant

## Scope

Add:
1. `MetricTile`
```tsx
<MetricTile
  label="Observed Providers"
  value={12}
  detail="Top provider: openai"
  loading={loading}
  variant="info"
/>
```

2. `MetricTileGrid`
```tsx
<MetricTileGrid>
  <MetricTile ... />
  <MetricTile ... />
</MetricTileGrid>
```

## Target files
- `packages/ui/contracts/metric-tile.edn`
- `packages/ui/react/src/primitives/MetricTile.tsx`
- `packages/ui/react/src/primitives/MetricTileGrid.tsx`

## First adopters in proxx
- `web/src/pages/AnalyticsPage.tsx` summary row
- `web/src/pages/DashboardPage.tsx` metrics row

## Verification
- Loading state uses shared Spinner
- At least 2 pages use `MetricTile`
- old summary card CSS can be deleted from proxx
