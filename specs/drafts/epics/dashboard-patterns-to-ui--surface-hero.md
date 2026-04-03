# Sub-spec: Surface hero + panel header components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 3
**Priority:** P2
**Status:** ✅ Done

## Problem

The dashboard repeats the same hero/header pattern on at least 4 pages:
- `DashboardPage` hero
- `HostsPage` hero
- `FederationPage` hero
- `AnalyticsPage` hero

Shared elements:
- kicker label (`dashboard-kicker`)
- large title
- descriptive subtitle
- right-side summary/meta block with numeric stats
- optional action area

## Scope

Add two reusable library components:

1. `SurfaceHero`
```tsx
<SurfaceHero
  kicker="Federation"
  title="Brethren control surface"
  description="Inspect self-state, peers, projected accounts..."
  stats={[
    { label: 'known peers', value: 3 },
    { label: 'projected accounts', value: 8 },
  ]}
  actions={<Button>Refresh</Button>}
/>
```

2. `PanelHeader`
```tsx
<PanelHeader
  title="Global Model Stats"
  description="How each model performs across observed providers."
  actions={<Input placeholder="Search models…" />}
/>
```

## Target files
- `orgs/open-hax/uxx/contracts/surface-hero.edn`
- `orgs/open-hax/uxx/contracts/panel-header.edn`
- `orgs/open-hax/uxx/react/src/primitives/SurfaceHero.tsx`
- `orgs/open-hax/uxx/react/src/primitives/PanelHeader.tsx`
- Storybook stories for both

## First adopters in proxx
- `web/src/pages/FederationPage.tsx`
- `web/src/pages/AnalyticsPage.tsx`

## Result
- `SurfaceHero` implemented and exported from `@open-hax/uxx`
- `PanelHeader` implemented and exported from `@open-hax/uxx`
- contracts added: `surface-hero.edn`, `panel-header.edn`
- stories added for both components
- adopted in 4 proxx pages: Dashboard, Hosts, Federation, Analytics

## Verification
- `npm run build` in `orgs/open-hax/uxx/react` passes
- `pnpm validate:required` in `orgs/open-hax/proxx` passes
- repeated hero/header markup replaced on multiple pages
