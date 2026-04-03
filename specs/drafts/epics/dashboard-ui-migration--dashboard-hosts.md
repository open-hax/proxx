# Sub-spec: Migrate DashboardPage + HostsPage to @open-hax/uxx primitives

**Epic:** `dashboard-ui-migration-epic.md`
**SP:** 3
**Priority:** P2
**Status:** Draft
**Depends on:** `dashboard-ui-migration--dependency-setup.md`

## Scope

Migrate the two simplest pages to establish the migration pattern.

### DashboardPage.tsx (663 lines → ~400 lines)
Replace:
- Hand-rolled stat cards → `<Card variant="elevated">`
- Status badges → `<Badge variant={status}>`
- Loading spinners → `<Spinner size="md" />`
- Progress bars → `<Progress value={usage} showValue />`
- Inline styles → design tokens from `@open-hax/uxx/tokens`

### HostsPage.tsx (246 lines → ~150 lines)
Replace:
- Host status cards → `<Card>` with `<Badge>` for status
- Connection status indicators → `<Badge variant="success|error|warning">`
- Action buttons → `<Button variant="primary|secondary|ghost">`

### Changes
- `web/src/pages/DashboardPage.tsx` — replace hand-rolled components
- `web/src/pages/HostsPage.tsx` — replace hand-rolled components
- `web/src/styles.css` — remove styles that are now provided by @open-hax/uxx tokens

### Verification
- `pnpm web:build` passes
- Dashboard renders identically (or better) with @open-hax/uxx components
- Hosts page shows correct status badges and action buttons
- No custom CSS needed for these two pages
