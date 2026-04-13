# Spec 2.5: Clean Request Utils

**Spec ID:** POLICY-CONSOLIDATE-001-08
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 1
**Priority:** Low
**Dependencies:** None

## Objective

Move policy-adjacent functions out of `request-utils.ts` and verify the remaining utilities are genuinely generic HTTP/request utilities.

## Current Location

`src/lib/request-utils.ts` (233 lines)

## Functions to Move

### To `policy/adapters/route-filtering.ts`

| Function | Lines | Purpose |
|----------|-------|---------|
| `extractPromptCacheKey` | ~15 | Extract prompt cache key from body |
| `hashPromptCacheKey` | ~10 | Hash prompt cache key for logging |

### To `openai/request-handling.ts`

| Function | Lines | Purpose |
|----------|-------|---------|
| `summarizeResponsesRequestBody` | ~50 | Summarize request for logging |

**Note:** This is tracked in Spec 2.4, just verify it's moved.

## Functions to Keep

The following are genuinely generic HTTP/request utilities:

| Function | Lines | Purpose |
|----------|-------|---------|
| `readCookieToken` | ~20 | Cookie parsing |
| `parseJsonIfPossible` | ~10 | JSON parsing helper |
| `readSingleHeader` | ~10 | Header extraction |
| `escapeHtml` | ~10 | HTML escaping |
| `normalizeRequestedModel` | ~10 | Model ID normalization |
| `isTrustedLocalBridgeAddress` | ~10 | Local address check |
| `copyInjectedResponseHeaders` | ~15 | Response header copying |
| `SUPPORTED_V1_ENDPOINTS` | ~10 | Endpoint list constant |
| `SUPPORTED_NATIVE_OLLAMA_ENDPOINTS` | ~10 | Endpoint list constant |

## Implementation Steps

1. Move `extractPromptCacheKey`, `hashPromptCacheKey` to `policy/adapters/route-filtering.ts`
2. Verify `summarizeResponsesRequestBody` moved to `openai/request-handling.ts`
3. Update imports in dependents
4. Review remaining functions - ensure they're all generic
5. Run tests, verify all pass

## Import Changes

**Before:**
```typescript
import { extractPromptCacheKey, hashPromptCacheKey } from "../request-utils.js";
```

**After:**
```typescript
import { extractPromptCacheKey, hashPromptCacheKey } from "../policy/adapters/route-filtering.js";
```

## Test Updates

- Move cache key tests to `tests/policy/route-filtering.test.ts`
- Verify request-utils tests still cover generic functions

## Acceptance Criteria

- [ ] Prompt cache functions moved to policy
- [ ] Summarize function moved to openai (verify Spec 2.4)
- [ ] All imports updated
- [ ] `request-utils.ts` contains only generic utilities
- [ ] All tests pass

## Risk Assessment

**Risk Level:** Low

- Small scope, few functions
- Clear destination for each function
- Easy to verify correctness

## Estimated Time

0.5-1 hour
