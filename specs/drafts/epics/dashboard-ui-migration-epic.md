# Epic: Migrate proxx dashboard frontend to @open-hax/uxx component library

**Status:** ✅ Done (5 of 5 sub-specs done)
**Epic SP:** 13 (broken into 5 sub-specs ≤5 SP each)
**Priority:** P2
**Parent:** `specs/drafts/dashboard-ui-modernization.md`

## Problem

The proxx web dashboard (`web/src/`) uses hand-rolled CSS and inline styles across 6637 lines of frontend code. The `@open-hax/uxx` component library at `orgs/open-hax/uxx/` provides 35+ production-ready React components with design tokens, Storybook documentation, and consistent accessibility.

## Sub-specs

| # | Sub-spec | SP | Status | File |
|---|----------|----|--------|------|
| 1 | Add @open-hax/uxx dependency + ToastProvider + global theme | 2 | ✅ Done | `epics/dashboard-ui-migration--dependency-setup.md` |
| 2 | Migrate DashboardPage + HostsPage (primitives) | 3 | ✅ Done | `epics/dashboard-ui-migration--dashboard-hosts.md` |
| 3 | Migrate CredentialsPage (cards, modals, progress) | 5 | ✅ Done | `epics/dashboard-ui-migration--credentials.md` |
| 4 | Migrate FederationPage + AnalyticsPage (tabs, feed, badges) | 3 | ✅ Done | `epics/dashboard-ui-migration--federation-analytics.md` |
| 5 | Migrate ChatPage + remove custom CSS | 3 | ✅ Done | `epics/dashboard-ui-migration--chat-cleanup.md` |

## What's done

### Page-level migration (all 8 pages)
- ✅ **DashboardPage**: Badge, Spinner, SurfaceHero, PanelHeader, MetricTile, MetricTileGrid (with sparkbar support)
- ✅ **HostsPage**: Badge, PanelHeader, Spinner, SurfaceHero, DataTableShell (routes + containers tables)
- ✅ **CredentialsPage**: Badge, Card, Input, Modal, Progress, Spinner, StatusChipStack, Tabs, Tooltip, useToast
- ✅ **FederationPage**: ActionStrip, Badge, Button, Card, FilterToolbar, Input, PanelHeader, Spinner, SurfaceHero, Tabs
- ✅ **AnalyticsPage**: DataTableShell, FilterToolbar, Input, MetricTile, MetricTileGrid, PanelHeader, SurfaceHero, Tabs
- ✅ **ChatPage**: Button, Chat (with reasoning trace support), Input, PanelHeader
- ✅ **ImagesPage**: Button, Card, Input, Spinner
- ✅ **ToolsPage**: Badge, Button, Card, Input (fully migrated from 0 @open-hax/uxx imports)

### Shared library primitives created (orgs/open-hax/uxx)
- ✅ `SurfaceHero` + `PanelHeader` — hero surfaces with kicker/title/stats/description
- ✅ `MetricTile` + `MetricTileGrid` — stat cards with sparkbar support
- ✅ `FilterToolbar` + `ActionStrip` — filter controls and action button strips
- ✅ `DataTableShell` — generic typed data table with sticky header, scroll, dense/wide modes
- ✅ `StatusChipStack` — badge stack helper with separators
- ✅ `Select` — styled dropdown matching Input visual style
- ✅ `Chat` — recovered from corruption, added reasoning trace `<details>` support

### Theme migration
- ✅ Proxx `styles.css` imports `@open-hax/uxx/css` as single source of truth
- ✅ All ~50 hardcoded hex colors replaced with monokai token references
- ✅ All rgba values derive from monokai palette
- ✅ Body background gradients shifted from ocean/navy to monokai warm dark

### Contracts created (orgs/open-hax/uxx/contracts)
- ✅ `surface-hero.edn`, `panel-header.edn`, `metric-tile.edn`
- ✅ `filter-toolbar.edn`, `action-strip.edn`, `status-chip-stack.edn`
- ✅ `data-table-shell.edn`, `select.edn`

### Test fixes
- ✅ E2e test updated for new AnalyticsPage headings (Controls, Analytics Views)
- ✅ E2e test updated for Chat component message rendering (`getByLabel('Assistant message')`)
- ✅ Chat component: added `role="article"` and `aria-label` to message bubbles
- ✅ Chat component: added `reasoningContent` prop with collapsible `<details>/<summary>` rendering
- ✅ Fixed duplicate "Analytics Views" section in AnalyticsPage

## What remains
- Global CSS cleanup: styles.css from 2171 → <500 lines (structure-only CSS after component adoption)
- DashboardPage: request log table and account health table still use hand-rolled div-based layouts (complex infinite scroll)
- CredentialsPage: quota bars could adopt Progress component, native buttons could adopt Button
- ImagesPage: native `<textarea>` elements could adopt a Textarea component
