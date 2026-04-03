# Sub-spec: Filter toolbar + action strip components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 2
**Priority:** P2
**Status:** Draft

## Problem

The dashboard repeats toolbar rows that combine filters and actions:
- `AnalyticsPage` toolbar (window, sort, provider, model)
- `FederationPage` owner-subject toolbar
- `CredentialsPage` top action/meta toolbar
- `ChatPage` model + refresh/fork action strip

## Scope

Add:
1. `FilterToolbar`
```tsx
<FilterToolbar>
  <Input placeholder="Search providers…" />
  <Select ... />
</FilterToolbar>
```

2. `ActionStrip`
```tsx
<ActionStrip>
  <Button>Refresh</Button>
  <Button variant="secondary">Default</Button>
</ActionStrip>
```

## Target files
- `packages/ui/contracts/filter-toolbar.edn`
- `packages/ui/react/src/primitives/FilterToolbar.tsx`
- `packages/ui/react/src/primitives/ActionStrip.tsx`

## First adopters in proxx
- `web/src/pages/FederationPage.tsx`
- `web/src/pages/AnalyticsPage.tsx`

## Verification
- Toolbars collapse/wrap cleanly on mobile widths
- 2+ proxx pages adopt the new components
