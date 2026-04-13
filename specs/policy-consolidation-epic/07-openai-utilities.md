# Spec 2.4: Extract OpenAI-Specific Utilities

**Spec ID:** POLICY-CONSOLIDATE-001-07
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** Low
**Dependencies:** Spec 2.1 (HTTP utilities)

## Objective

Extract OpenAI-specific request/response handling utilities from `provider-utils.ts` and `request-utils.ts` into dedicated `openai/` module.

## Current Location

- `src/lib/provider-utils.ts` (~60 lines)
- `src/lib/request-utils.ts` (~50 lines)

## Target Location

`src/lib/openai/request-handling.ts`

## Functions to Extract

### From `provider-utils.ts`

| Function | Lines | Purpose |
|----------|-------|---------|
| `requestWantsReasoningTrace` | ~25 | Check if request wants reasoning |
| `shouldEnableInterleavedThinkingHeader` | ~15 | Enable thinking header |
| `appendCsvHeaderValue` | ~15 | Append CSV header value |

### From `request-utils.ts`

| Function | Lines | Purpose |
|----------|-------|---------|
| `summarizeResponsesRequestBody` | ~50 | Summarize request for logging |

## Implementation Steps

1. Create `src/lib/openai/` directory
2. Create `request-handling.ts` with OpenAI functions
3. Add index.ts for public exports
4. Update imports in:
   - `src/routes/chat.ts`
   - `src/routes/responses.ts`
   - `src/lib/proxy.ts`
5. Run tests, verify behavior unchanged
6. Run full test suite

## Import Changes

**Before:**
```typescript
import { requestWantsReasoningTrace } from "../provider-utils.js";
import { summarizeResponsesRequestBody } from "../request-utils.js";
```

**After:**
```typescript
import { requestWantsReasoningTrace, summarizeResponsesRequestBody } from "../openai/request-handling.js";
```

## Test Updates

- Create `tests/openai/request-handling.test.ts`
- Test reasoning trace detection
- Test request body summarization
- Test thinking header logic

## Acceptance Criteria

- [ ] `openai/request-handling.ts` created
- [ ] Functions from both sources moved
- [ ] All imports updated
- [ ] Tests created
- [ ] All tests pass
- [ ] Functions removed from source files

## Risk Assessment

**Risk Level:** Low-Medium

- OpenAI-specific logic well-contained
- Used primarily in routes layer
- Less import surface than other splits

## Estimated Time

2 hours
