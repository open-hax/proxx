# Sub-spec: Status chip stack / badge list component

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 2
**Priority:** P2
**Status:** Draft

## Problem

Badge/pill clusters recur across the dashboard:
- `CredentialsPage` provider/status/plan/auth badge stacks
- `FederationPage` provider count pill lists
- `HostsPage` reachability + "This console" status stack

These are all currently ad hoc combinations of `Badge` with page-local spacing/layout wrappers.

## Scope

Add a small composition helper:

```tsx
<StatusChipStack
  items={[
    { label: 'openai', variant: 'info' },
    { label: 'pro', variant: 'success' },
    { label: 'oauth_bearer', variant: 'default' },
  ]}
/>
```

Features:
- wraps badges/chips consistently
- compact and default density
- optional counts/icons
- used as layout helper over existing `Badge`

## Target files
- `packages/ui/contracts/status-chip-stack.edn`
- `packages/ui/react/src/primitives/StatusChipStack.tsx`

## First adopters in proxx
- `web/src/pages/CredentialsPage.tsx`
- `web/src/pages/FederationPage.tsx`

## Verification
- badge stacks no longer rely on page-local wrapper classes
- 2+ pages adopt the component
