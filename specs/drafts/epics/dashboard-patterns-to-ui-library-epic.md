# Epic: Graduate repeated proxx dashboard patterns into @devel/ui

**Status:** ✅ Done (5 of 5 sub-specs done)
**Epic SP:** 15 (broken into 5 sub-specs ≤5 SP each)
**Priority:** P2
**Parent:** `specs/drafts/epics/dashboard-ui-migration-epic.md`

## Problem

As the proxx dashboard migrates onto `@open-hax/uxx`, several repeated local patterns have become obvious. These patterns are used across multiple dashboard pages and should be elevated into the shared component library instead of staying as one-off page/CSS constructs.

Repeated patterns observed in proxx:
- **Hero surfaces with kicker + title + summary stats** on Dashboard, Hosts, Federation, Analytics
- **Metric summary tiles** on Dashboard and Analytics, plus host stats blocks
- **Filter/action toolbars** on Analytics, Federation, Credentials, and Chat
- **Scrollable data tables with sticky headers** on Analytics, Hosts, Dashboard logs, Credentials audits
- **Status chip / badge stacks** on Credentials and Federation

These are currently implemented with page-local markup and `styles.css` classes, which makes the dashboard migration harder to complete cleanly and blocks broader reuse outside proxx.

## Sub-specs

| # | Sub-spec | SP | File |
|---|----------|----|------|
| 1 | Surface hero + panel header components | 3 | ✅ `epics/dashboard-patterns-to-ui--surface-hero.md` |
| 2 | Metric tile grid + stat card components | 3 | ✅ `epics/dashboard-patterns-to-ui--metric-tiles.md` |
| 3 | Filter toolbar + action strip components | 2 | ✅ `epics/dashboard-patterns-to-ui--toolbars.md` |
| 4 | Data table shell with sticky header + scroll region | 5 | ✅ `epics/dashboard-patterns-to-ui--data-table-shell.md` |
| 5 | Status chip stack / badge list component | 2 | ✅ `epics/dashboard-patterns-to-ui--status-chip-stack.md` |

## Execution order
1 ✅ → 2 ✅ → 3 ✅ → 4 ✅ → 5 ✅

## Definition of done
- ✅ New components live in `orgs/open-hax/uxx/react` with matching contracts in `orgs/open-hax/uxx/contracts`
- ✅ Each component has Storybook coverage and usage examples
- ✅ At least one proxx page adopts each new component
- ✅ `web/src/styles.css` shrinks because repeated local classes are removed in favor of shared library components

## What's done
- ✅ `SurfaceHero` implemented in `orgs/open-hax/uxx/react/src/primitives/SurfaceHero.tsx`
- ✅ `PanelHeader` implemented in `orgs/open-hax/uxx/react/src/primitives/PanelHeader.tsx`
- ✅ `MetricTile` implemented in `orgs/open-hax/uxx/react/src/primitives/MetricTile.tsx`
- ✅ `MetricTileGrid` implemented in `orgs/open-hax/uxx/react/src/primitives/MetricTileGrid.tsx`
- ✅ `FilterToolbar` implemented in `orgs/open-hax/uxx/react/src/primitives/FilterToolbar.tsx`
- ✅ `ActionStrip` implemented in `orgs/open-hax/uxx/react/src/primitives/ActionStrip.tsx`
- ✅ `DataTableShell` implemented in `orgs/open-hax/uxx/react/src/primitives/DataTableShell.tsx`
- ✅ `StatusChipStack` implemented in `orgs/open-hax/uxx/react/src/primitives/StatusChipStack.tsx`
- ✅ matching contracts added in `orgs/open-hax/uxx/contracts/`
- ✅ Storybook stories added for primitives
- ✅ adopted in proxx `DashboardPage`, `HostsPage`, `FederationPage`, `AnalyticsPage`, `CredentialsPage`
- ✅ `@open-hax/uxx` build passes after fixing pre-existing `ReactReagentSeam` token reference
- ✅ `pnpm web:build` and `pnpm web:test` pass
