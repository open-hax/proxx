# Sub-spec: Add @open-hax/uxx dependency + ToastProvider + global theme

**Epic:** `dashboard-ui-migration-epic.md`
**SP:** 2
**Priority:** P2
**Status:** Draft

## Scope

1. Add `@open-hax/uxx` and `@open-hax/uxx/tokens` as dependencies to proxx web package
2. Wrap the app with `ToastProvider` from `@open-hax/uxx`
3. Import design tokens and apply global theme overrides
4. Create a `components/` barrel file for re-exporting @open-hax/uxx components with proxx-specific defaults

### Changes
- `web/package.json` (or root `package.json`) — add `@open-hax/uxx` and `@open-hax/uxx/tokens` dependencies
- `web/src/App.tsx` — wrap with `<ToastProvider position="top-right">`
- `web/src/styles.css` — import token CSS variables, remove duplicate color/spacing definitions
- `web/src/components/index.ts` — new barrel file:
  ```typescript
  export { Button, Badge, Spinner, Card, Modal, Tooltip, Input, Progress } from '@open-hax/uxx';
  export { colors, spacing, typography, shadow } from '@open-hax/uxx/tokens';
  ```

### Verification
- `pnpm install` succeeds
- `pnpm web:build` passes
- Toast notifications work: `addToast({ type: 'success', message: 'Test' })`
- Global styles apply design tokens consistently
