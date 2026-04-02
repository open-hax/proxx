# Epic: Control-plane contract + legacy deprecation

**Status:** ✅ Done (1 of 3 sub-specs blocked on federation-slice)
**Epic SP:** 8 (broken into 3 sub-specs ≤5 SP each)
**Priority:** P0
**Parent files:** `specs/drafts/control-plane-api-contract-v1.md`, `specs/drafts/legacy-api-ui-deprecation.md`

## What's done
- ✅ Phase A: path contract locked, four surfaces documented
- ✅ Phase B: `/api/v1/*` canonical, route modules import neutral types, sequential registration
- ✅ All primary control-plane slices have `/api/v1/*` equivalents
- ✅ `ui-routes.ts` reduced to 62-line setup-only barrel
- ✅ Frontend migrated to `/api/v1/*` (37 references, zero `/api/ui/`)
- ✅ Deprecation headers live (`Deprecation: true` + `Link` header)
- ✅ Token refresh extracted from app.ts (976→897 lines)
- ✅ Catalog alias resolution extracted to `catalog-alias-resolver.ts`

## What remains

| # | Sub-spec | SP | Status | File |
|---|----------|----|--------|------|
| 1 | Frontend callsite migration to `/api/v1/*` | 3 | ✅ Done | `epics/contract-deprecation--frontend-migration.md` |
| 2 | Deprecation headers + parity tests | 3 | ✅ Done | `epics/contract-deprecation--deprecation-headers.md` |
| 3 | OpenAPI ownership + ui-routes.ts removal | 2 | ⬜ Blocked on federation-slice | `epics/contract-deprecation--openapi-cleanup.md` |

### Blocker for #3
Advanced federation routes (`tenant-provider-policies`, `diff-events`, `sync/pull`, `projected-accounts/*`, `federation/accounts/*`) are only registered via `registerFederationUiRoutes` — not yet at `/api/v1/*`. Tests depend on these. Must complete `federation-slice--advanced-routes.md` (3 SP) first.

## Definition of done
- ✅ `web/src/lib/api.ts` uses `/api/v1/*` for all control-plane calls
- ✅ `/api/ui/*` routes return `Deprecation: true` header
- ⬜ `src/lib/ui-routes.ts` is deleted (blocked)
- ⬜ `/api/v1/openapi.json` is the canonical control-plane spec (blocked)
