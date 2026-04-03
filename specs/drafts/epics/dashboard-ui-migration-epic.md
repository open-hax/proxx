# Epic: Migrate proxx dashboard frontend to @devel/ui component library

**Status:** Partial (3 of 5 sub-specs done, 2 partial)
**Epic SP:** 13 (broken into 5 sub-specs ≤5 SP each)
**Priority:** P2
**Parent:** `specs/drafts/dashboard-ui-modernization.md`

## Problem

The proxx web dashboard (`web/src/`) uses hand-rolled CSS and inline styles across 6637 lines of frontend code. The `@devel/ui` component library at `packages/ui/` provides 19 production-ready React components with design tokens, Storybook documentation, and consistent accessibility.

## Sub-specs

| # | Sub-spec | SP | Status | File |
|---|----------|----|--------|------|
| 1 | Add @devel/ui dependency + ToastProvider + global theme | 2 | ✅ Done | `epics/dashboard-ui-migration--dependency-setup.md` |
| 2 | Migrate DashboardPage + HostsPage (primitives) | 3 | ✅ Done | `epics/dashboard-ui-migration--dashboard-hosts.md` |
| 3 | Migrate CredentialsPage (cards, modals, progress) | 5 | ✅ Done | `epics/dashboard-ui-migration--credentials.md` |
| 4 | Migrate FederationPage + AnalyticsPage (tabs, feed, badges) | 3 | ⬜ Partial (imports added) | `epics/dashboard-ui-migration--federation-analytics.md` |
| 5 | Migrate ChatPage + remove custom CSS | 3 | ⬜ Partial (imports added) | `epics/dashboard-ui-migration--chat-cleanup.md` |

## What's done
- ✅ `@devel/ui-react` and `@devel/ui-tokens` added as dependencies
- ✅ `web/src/components/index.ts` barrel file created
- ✅ App.tsx wrapped with `<ToastProvider position="top-right">`
- ✅ HostsPage: status pills → Badge, loading → Spinner
- ✅ DashboardPage: loading "..." → Spinner, 4 status pill patterns → Badge
- ✅ CredentialsPage: all 15+ hand-rolled badge patterns → Badge components
- ✅ FederationPage: provider list badges → Badge
- ✅ AnalyticsPage + ChatPage: @devel/ui imports added

## What remains
- FederationPage: tab navigation → Tabs component, loading → Spinner
- AnalyticsPage: status indicators → Badge, loading → Spinner
- ChatPage: full replacement with @devel/ui Chat component (requires restructuring session management, model selection, streaming)
- Global CSS cleanup: styles.css from 2267 → <500 lines
