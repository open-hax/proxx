# Epic: Control-plane contract + legacy deprecation

**Status:** Partial (Phases A-B done for both)
**Epic SP:** 8 (broken into 3 sub-specs ≤5 SP each)
**Priority:** P0
**Parent files:** `specs/drafts/control-plane-api-contract-v1.md`, `specs/drafts/legacy-api-ui-deprecation.md`

## What's done
- ✅ Phase A: path contract locked, four surfaces documented
- ✅ Phase B: `/api/v1/*` canonical, route modules import neutral types, sequential registration
- ✅ All primary control-plane slices have `/api/v1/*` equivalents
- ✅ `ui-routes.ts` reduced to 62-line setup-only barrel

## What remains

| # | Sub-spec | SP | File |
|---|----------|----|------|
| 1 | Frontend callsite migration to `/api/v1/*` | 3 | `epics/contract-deprecation--frontend-migration.md` |
| 2 | Deprecation headers + parity tests | 3 | `epics/contract-deprecation--deprecation-headers.md` |
| 3 | OpenAPI ownership + ui-routes.ts removal | 2 | `epics/contract-deprecation--openapi-cleanup.md` |

## Definition of done
- `web/src/lib/api.ts` uses `/api/v1/*` for all control-plane calls
- `/api/ui/*` routes return `Deprecation: true` header
- Parity tests confirm identical responses at both prefixes
- `src/lib/ui-routes.ts` is deleted or a zero-logic shim
- `/api/v1/openapi.json` is the canonical control-plane spec
