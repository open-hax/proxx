# Spec 2.1: Extract HTTP Utilities

**Spec ID:** POLICY-CONSOLIDATE-001-04
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** Medium
**Dependencies:** None

## Objective

Extract HTTP-related utilities from `provider-utils.ts` into focused `http/` directory modules.

## Current Location

`src/lib/provider-utils.ts` (568 lines, extracting ~100 lines)

## Target Location

`src/lib/http/fetch-utils.ts` and `src/lib/http/url-utils.ts`

## Functions to Extract

### `http/fetch-utils.ts` (~60 lines)

| Function | Lines | Purpose |
|----------|-------|---------|
| `fetchWithResponseTimeout` | ~20 | Fetch with response timeout |
| `fetchWithAbortSignal` | ~15 | Fetch with abort signal |
| `readResponseBody` | ~10 | Read response body as text |
| `readResponseJson` | ~10 | Read response body as JSON |

### `http/url-utils.ts` (~30 lines)

| Function | Lines | Purpose |
|----------|-------|---------|
| `joinUrl` | ~15 | Join base URL with path |
| `normalizeUpstreamUrl` | ~10 | Normalize URL for upstream |

**Note:** `joinUrl` currently exists in `request-utils.ts` - move from there instead.

## Implementation Steps

1. Create `src/lib/http/` directory
2. Create `fetch-utils.ts` with fetch-related functions
3. Create `url-utils.ts` with URL utilities
4. Add index.ts for public exports
5. Update imports across codebase:
   - `src/routes/chat.ts`
   - `src/routes/responses.ts`
   - `src/lib/provider-strategy/*.ts`
6. Run tests, verify all pass

## Import Changes

**Before:**
```typescript
import { fetchWithResponseTimeout, joinUrl } from "../provider-utils.js";
```

**After:**
```typescript
import { fetchWithResponseTimeout } from "../http/fetch-utils.js";
import { joinUrl } from "../http/url-utils.js";
```

## Test Updates

- Create `tests/http/fetch-utils.test.ts`
- Create `tests/http/url-utils.test.ts`
- Move relevant tests from `provider-utils.test.ts`

## Acceptance Criteria

- [ ] `http/fetch-utils.ts` created with fetch utilities
- [ ] `http/url-utils.ts` created with URL utilities
- [ ] All imports updated
- [ ] Tests moved/created
- [ ] All tests pass
- [ ] Functions removed from `provider-utils.ts`

## Risk Assessment

**Risk Level:** Medium

- HTTP utilities are used throughout request handling
- Need to verify timeout behavior unchanged
- Import surface is large

## Estimated Time

2 hours
