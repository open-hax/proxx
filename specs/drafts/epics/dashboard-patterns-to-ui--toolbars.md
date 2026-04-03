# Sub-spec: Filter toolbar + action strip components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 2
**Priority:** P2
**Status:** ✅ Done

## Result
- `FilterToolbar` implemented in `orgs/open-hax/uxx/react/src/primitives/FilterToolbar.tsx`
- `ActionStrip` implemented in `orgs/open-hax/uxx/react/src/primitives/ActionStrip.tsx`
- contract added: `orgs/open-hax/uxx/contracts/filter-toolbar.edn`
- contract added: `orgs/open-hax/uxx/contracts/action-strip.edn`
- adopted in `web/src/pages/AnalyticsPage.tsx` (controls toolbar + search toolbar)
- adopted in `web/src/pages/FederationPage.tsx` (owner-subject toolbar with refresh/default buttons)

## Verification
- `npm run build` in `orgs/open-hax/uxx/react` passes
- `pnpm web:build` in `orgs/open-hax/proxx` passes
- `pnpm web:test` in `orgs/open-hax/proxx` passes
- toolbars wrap cleanly via flex-wrap on narrow widths
- replaced page-local `analytics-toolbar` and `federation-toolbar-actions` divs
