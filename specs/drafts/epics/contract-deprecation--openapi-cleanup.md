# Sub-spec: OpenAPI ownership + ui-routes.ts removal

**Epic:** `contract-deprecation-epic.md`
**Epic SP:** 2
**Priority:** P0
**Status:** ✅ Done

## What was done
- Deleted `src/lib/ui-routes.ts` (62-line monolith barrel)
- Replaced `registerUiRoutes` with `registerWebSocketRoutes` + `registerApiV1Routes` in `app.ts`
- Migrated 57 test URLs from `/api/ui/*` to `/api/v1/*` across 3 test files
- All advanced federation routes now available at `/api/v1/federation/*`
- 162/162 proxy tests pass, container healthy
