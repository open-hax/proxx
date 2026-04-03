# Sub-spec: Surface hero + panel header components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 3
**Priority:** P2
**Status:** Draft

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
- `packages/ui/contracts/surface-hero.edn`
- `packages/ui/contracts/panel-header.edn`
- `packages/ui/react/src/primitives/SurfaceHero.tsx`
- `packages/ui/react/src/primitives/PanelHeader.tsx`
- Storybook stories for both

## First adopters in proxx
- `web/src/pages/FederationPage.tsx`
- `web/src/pages/AnalyticsPage.tsx`

## Verification
- Storybook stories render all hero/header variants
- At least 2 proxx pages adopt the new components
- `dashboard-kicker`, `*-hero-meta`, and `*-panel-header` CSS usage drops
