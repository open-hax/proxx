# Sub-spec: OpenAPI ownership + ui-routes.ts removal

**Epic:** `contract-deprecation-epic.md`
**Epic SP:** 2
**Priority:** P0
**Status:** ⬜ Blocked on federation-slice epic

## Blocker

The tests exercise advanced federation routes that are ONLY registered via `registerFederationUiRoutes`:
- `tenant-provider-policies`
- `diff-events`
- `sync/pull`
- `projected-accounts/import`, `projected-accounts/imported`
- `federation/accounts`, `federation/accounts/export`

These routes are NOT yet available at `/api/v1/*`. They live exclusively in `ui-routes.ts` → `registerFederationUiRoutes`.

## Resolution path

1. Complete `federation-slice--advanced-routes.md` (3 SP) — extract these routes to `/api/v1/federation/*`
2. Then migrate test URLs from `/api/ui/` to `/api/v1/`
3. Then remove `registerUiRoutes` + delete `ui-routes.ts`

## Remaining work (after federation-slice)

1. Migrate 14 test URLs in `tenant-provider-policy-routes.test.ts` from `/api/ui/` to `/api/v1/`
2. Migrate `federation-bridge-relay.test.ts` WS URL from `/api/ui/federation/bridge/ws` to `/api/v1/federation/bridge/ws`
3. Remove `registerUiRoutes` call from `app.ts`
4. Delete `src/lib/ui-routes.ts`
5. Remove `/api/ui/*` route registrations from route modules
