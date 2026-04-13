# Spec 1.1: Move Tenant Policy Enforcement

**Spec ID:** POLICY-CONSOLIDATE-001-01
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** High
**Dependencies:** None

## Objective

Move tenant policy enforcement functions from `tenant-policy-helpers.ts` to `policy/engine/tenant-enforcement.ts` to consolidate all policy logic under the policy directory.

## Current Location

`src/lib/tenant-policy-helpers.ts` (90 lines)

## Target Location

`src/lib/policy/engine/tenant-enforcement.ts`

## Functions to Move

| Function | Lines | Purpose |
|----------|-------|---------|
| `normalizeModelVariants` | ~15 | Internal helper for model ID normalization |
| `tenantModelAllowed` | ~25 | Check if tenant allows a model |
| `tenantProviderAllowed` | ~15 | Check if tenant allows a provider |
| `filterTenantProviderRoutes` | ~10 | Filter routes by tenant policy |
| `resolveExplicitTenantProviderId` | ~20 | Resolve blocked provider from prefix |

## Implementation Steps

1. Create `src/lib/policy/engine/tenant-enforcement.ts`
2. Copy functions from `tenant-policy-helpers.ts`
3. Add exports to `policy/engine/index.ts`
4. Update imports in dependents:
   - `src/routes/chat.ts`
   - `src/routes/responses.ts`
   - `src/lib/model-routing-pipeline.ts`
5. Run tests, verify all pass
6. Delete `tenant-policy-helpers.ts`
7. Run full test suite

## Import Changes

**Before:**
```typescript
import { tenantModelAllowed, resolveExplicitTenantProviderId } from "../tenant-policy-helpers.js";
```

**After:**
```typescript
import { tenantModelAllowed, resolveExplicitTenantProviderId } from "../policy/engine/tenant-enforcement.js";
```

## Test Updates

- Update `src/tests/tenant-provider-policy.test.ts` imports
- Verify existing tests still pass

## Acceptance Criteria

- [ ] Functions moved to `policy/engine/tenant-enforcement.ts`
- [ ] All imports updated across codebase
- [ ] All existing tests pass
- [ ] `tenant-policy-helpers.ts` deleted
- [ ] No behavior changes

## Risk Assessment

**Risk Level:** Low

- Pure move operation, no logic changes
- Well-defined function boundaries
- Clear import surface
- Easy rollback (restore deleted file)

## Estimated Time

1-2 hours
