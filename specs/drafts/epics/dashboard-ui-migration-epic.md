# Epic: Migrate proxx dashboard frontend to @devel/ui component library

**Status:** Partial (4 of 5 sub-specs done, 1 advanced partial)
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
| 4 | Migrate FederationPage + AnalyticsPage (tabs, feed, badges) | 3 | ⬜ Partial (inputs/buttons/spinners/badges migrated) | `epics/dashboard-ui-migration--federation-analytics.md` |
| 5 | Migrate ChatPage + remove custom CSS | 3 | ✅ Done (Chat surface migrated; CSS cleanup remains epic-level) | `epics/dashboard-ui-migration--chat-cleanup.md` |

## What's done
- ✅ `@devel/ui-react` and `@devel/ui-tokens` added as dependencies
- ✅ `web/src/components/index.ts` barrel file created
- ✅ App.tsx wrapped with `<ToastProvider position="top-right">`
- ✅ HostsPage: status pills → Badge, loading → Spinner
- ✅ DashboardPage: loading "..." → Spinner, 4 status pill patterns → Badge
- ✅ CredentialsPage: all 15+ hand-rolled badge patterns → Badge components
- ✅ FederationPage: provider list badges → Badge, toolbar/form inputs → Input, action buttons → Button, peer status → Badge
- ✅ AnalyticsPage: summary loading states → Spinner, search inputs → Input
- ✅ ChatPage: full thread/input surface replaced with `@devel/ui` `Chat`, plus session/search/action/send controls → shared components
- ✅ ImagesPage: model input → Input, generate → Button, image results → Card, response wait state → Spinner
- ✅ Frontend smoke harness covers dashboard, hosts, credentials, tools, analytics, federation, chat, and images

## What remains
- FederationPage: tab navigation → Tabs component (optional enhancement)
- AnalyticsPage: richer status tokens/cards beyond current spinner/input migration
- Global CSS cleanup: styles.css from 2267 → <500 lines
