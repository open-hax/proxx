# Sub-spec: Frontend callsite migration to /api/v1/*

**Epic:** `contract-deprecation-epic.md`
**SP:** 3
**Priority:** P0
**Status:** Draft

## Scope
Update `web/src/lib/api.ts` and all frontend call sites to use `/api/v1/*` exclusively for control-plane API calls.

### Changes
1. Audit `web/src/lib/api.ts` for all `/api/ui/*` URLs
2. Replace with `/api/v1/*` equivalents
3. Update any component-level fetch calls that hardcode `/api/ui/*`
4. Verify the web dashboard still works after migration

### Files to modify
- `web/src/lib/api.ts` — main API client
- Any `.tsx` files with hardcoded `/api/ui/*` fetch calls

## Verification
- `rg "/api/ui/" web/src/` returns zero results (except possibly in comments/docs)
- Web dashboard loads and functions correctly at `http://localhost:5174`
- `pnpm build` passes
