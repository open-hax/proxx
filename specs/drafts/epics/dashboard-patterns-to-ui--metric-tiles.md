# Sub-spec: Metric tile grid + stat card components

**Epic:** `dashboard-patterns-to-ui-library-epic.md`
**SP:** 3
**Priority:** P2
**Status:** ✅ Done
**Depends on:** `dashboard-patterns-to-ui--surface-hero.md` ✅

## Result
- `MetricTile` implemented in `orgs/open-hax/uxx/react/src/primitives/MetricTile.tsx`
- `MetricTileGrid` implemented in `orgs/open-hax/uxx/react/src/primitives/MetricTileGrid.tsx`
- contract added: `orgs/open-hax/uxx/contracts/metric-tile.edn`
- Storybook stories added for loading/default/variant grid states
- adopted in `web/src/pages/AnalyticsPage.tsx` summary row

## Verification
- `npm run build` in `orgs/open-hax/uxx/react` passes
- `pnpm validate:required` in `orgs/open-hax/proxx` passes
- Analytics summary cards now use shared metric primitives instead of page-local card markup
