# Sub-spec: OpenAPI ownership + ui-routes.ts removal

**Epic:** `contract-deprecation-epic.md`
**SP:** 2
**Priority:** P0
**Status:** Draft
**Depends on:** `contract-deprecation--deprecation-headers.md`

## Scope
Final cleanup: make `/api/v1/openapi.json` control-plane-filtered and remove `ui-routes.ts`.

### Changes
1. Ensure `/api/v1/openapi.json` serves the control-plane OpenAPI spec (or document why whole-app is preferred in v1)
2. Remove `registerUiRoutes` call from `app.ts`
3. Delete `src/lib/ui-routes.ts` (currently 62 lines, setup-only barrel)
4. Remove `/api/ui/*` route registrations from all route modules
5. Remove `LEGACY_*_ROUTE_PREFIX` constants

### Pre-removal checklist
- [ ] All frontend callsites migrated to `/api/v1/*`
- [ ] All parity tests pass
- [ ] Deprecation headers confirmed working
- [ ] No other code imports from `ui-routes.ts`

## Verification
- `rg "ui-routes" src/` returns zero results
- `rg "/api/ui/" src/` returns zero results
- `/api/v1/openapi.json` is accessible
- 162/162 proxy tests pass
