# Spec 1.2: Move Route Filtering Logic

**Spec ID:** POLICY-CONSOLIDATE-001-02
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** High
**Dependencies:** None

## Objective

Move route filtering functions from `model-routing-helpers.ts` to `policy/adapters/route-filtering.ts` to consolidate policy-adjacent routing decisions.

## Current Location

`src/lib/model-routing-helpers.ts` (185 lines)

## Target Location

`src/lib/policy/adapters/route-filtering.ts`

## Functions to Move

| Function | Lines | Purpose |
|----------|-------|---------|
| `providerRouteSupportsModel` | ~20 | Check if provider supports a model |
| `filterProviderRoutesByModelSupport` | ~10 | Filter routes by model support |
| `filterProviderRoutesByCatalogAvailability` | ~40 | Filter routes by catalog availability |
| `shouldRejectModelFromProviderCatalog` | ~25 | Catalog rejection logic |
| `providerCatalogEntrySupportsModel` | ~20 | Internal: check catalog entry |
| `catalogHasDynamicOllamaModel` | ~10 | Check for dynamic Ollama models |

## Functions to Keep (rename to catalog-resolution.ts)

| Function | Lines | Purpose |
|----------|-------|---------|
| `resolvableConcreteModelIds` | ~15 | Catalog resolution |
| `resolvableConcreteModelIdsForProviders` | ~30 | Catalog resolution |
| `openAiProviderUsesCodexSurface` | ~15 | Config utility |

## Implementation Steps

1. Create `src/lib/policy/adapters/route-filtering.ts`
2. Copy filtering functions from `model-routing-helpers.ts`
3. Add exports to `policy/adapters/index.ts`
4. Update imports in dependents:
   - `src/routes/chat.ts`
   - `src/routes/responses.ts`
   - `src/routes/images.ts`
5. Rename remaining `model-routing-helpers.ts` to `catalog-resolution.ts`
6. Update imports for catalog functions
7. Run tests, verify all pass
8. Run full test suite

## Import Changes

**Before:**
```typescript
import {
  filterProviderRoutesByModelSupport,
  filterProviderRoutesByCatalogAvailability
} from "../model-routing-helpers.js";
```

**After:**
```typescript
import {
  filterProviderRoutesByModelSupport,
  filterProviderRoutesByCatalogAvailability
} from "../policy/adapters/route-filtering.js";
```

## Test Updates

- Split `src/tests/model-routing-helpers.test.ts`:
  - Route filtering tests → `tests/policy/route-filtering.test.ts`
  - Catalog resolution tests → `tests/catalog-resolution.test.ts`
- Update imports in existing tests

## Acceptance Criteria

- [ ] Filtering functions moved to `policy/adapters/route-filtering.ts`
- [ ] Catalog functions remain in `catalog-resolution.ts`
- [ ] All imports updated across codebase
- [ ] Tests split appropriately
- [ ] All tests pass
- [ ] No behavior changes

## Risk Assessment

**Risk Level:** Low-Medium

- Larger import surface than 1.1
- Test file needs splitting
- More dependents to update
- Still pure move operation

## Estimated Time

2-3 hours
