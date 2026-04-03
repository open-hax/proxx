# Sub-spec: Status chip stack / badge list component

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 2
**Priority:** P2
**Status:** ✅ Done

## Result
- `StatusChipStack` implemented in `orgs/open-hax/uxx/react/src/primitives/StatusChipStack.tsx`
- contract added: `orgs/open-hax/uxx/contracts/status-chip-stack.edn`
- adopted in `web/src/pages/CredentialsPage.tsx` (credential badge stacks in account tiles)
- wraps existing `Badge` component with consistent spacing and separators

## Features implemented
- accepts array of `{ label, variant, icon }` items
- renders Badge components with configurable size (xs/sm/md)
- configurable separator between chips (default: `·`)
- consistent gap spacing via token values

## Verification
- `npm run build` in `orgs/open-hax/uxx/react` passes
- `pnpm web:build` in `orgs/open-hax/proxx` passes
- badge stacks in CredentialsPage use shared component instead of inline Badge elements
