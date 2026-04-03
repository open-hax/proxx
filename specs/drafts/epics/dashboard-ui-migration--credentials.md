# Sub-spec: Migrate CredentialsPage to @open-hax/uxx components

**Epic:** `dashboard-ui-migration-epic.md`
**SP:** 5
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-ui-migration--dashboard-hosts.md`

## Scope

Migrate the largest and most complex page (1819 lines) using @open-hax/uxx primitives and AI/IDE components.

### Replacements
| Current | @open-hax/uxx Component |
|---------|-------------------|
| Credential cards | `<Card variant="outlined">` with `<Badge>` for status |
| Account health bars | `<Progress variant="success|warning|error">` |
| Refresh spinners | `<Spinner size="sm">` |
| Filter/search inputs | `<Input type="search" leftIcon={SearchIcon}>` |
| Confirmation dialogs | `<Modal>` with `<Button variant="danger">` |
| Status tooltips | `<Tooltip content="...">` wrapping `<Badge>` |
| Tab navigation | `<Tabs variant="enclosed">` |
| Toast notifications | `useToast().addToast()` |
| Manual refresh button | `<Button variant="primary" loading={refreshing}>` |

### Structural changes
- Split monolithic CredentialsPage into sub-components:
  - `CredentialsPage.tsx` — layout + state management (~300 lines)
  - `CredentialCard.tsx` — individual account card (~150 lines)
  - `CredentialFilters.tsx` — search + filter bar (~80 lines)
  - `CredentialActions.tsx` — refresh, enable/disable, delete (~100 lines)
- Target: 1819 → ~630 lines total (65% reduction)

### Changes
- `web/src/pages/CredentialsPage.tsx` — split into components, replace with @devel/ui
- `web/src/pages/CredentialsPage/CredentialCard.tsx` — new
- `web/src/pages/CredentialsPage/CredentialFilters.tsx` — new
- `web/src/pages/CredentialsPage/CredentialActions.tsx` — new
- `web/src/styles.css` — remove credential-specific styles

### Verification
- `pnpm web:build` passes
- All credential operations work (refresh, enable/disable, delete, search, filter)
- OAuth refresh flow works with toast notifications
- Page renders correctly on desktop and mobile widths
