# Spec 2.2: Extract SSE Parsing

**Spec ID:** POLICY-CONSOLIDATE-001-05
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** Medium
**Dependencies:** Spec 2.1 (HTTP utilities)

## Objective

Extract SSE (Server-Sent Events) parsing utilities from `provider-utils.ts` into dedicated `sse/` module.

## Current Location

`src/lib/provider-utils.ts` (568 lines, extracting ~80 lines)

## Target Location

`src/lib/sse/parsing.ts`

## Functions to Extract

| Function | Lines | Purpose |
|----------|-------|---------|
| `extractSseDataLines` | ~15 | Extract data lines from SSE payload |
| `stripSseCommentLines` | ~10 | Remove comment lines from SSE |
| `streamPayloadHasReasoningTrace` | ~30 | Check for reasoning in stream |
| `parseSseStream` | ~20 | Async generator for SSE parsing |

## Implementation Steps

1. Create `src/lib/sse/` directory
2. Create `parsing.ts` with SSE functions
3. Add index.ts for public exports
4. Update imports in streaming handlers:
   - `src/routes/chat.ts`
   - `src/routes/responses.ts`
   - `src/lib/streaming/*.ts`
5. Run tests, verify streaming still works
6. Run full test suite

## Import Changes

**Before:**
```typescript
import { extractSseDataLines, streamPayloadHasReasoningTrace } from "../provider-utils.js";
```

**After:**
```typescript
import { extractSseDataLines, streamPayloadHasReasoningTrace } from "../sse/parsing.js";
```

## Test Updates

- Create `tests/sse/parsing.test.ts`
- Test SSE line extraction edge cases
- Test reasoning trace detection
- Move relevant tests from `provider-utils.test.ts`

## Acceptance Criteria

- [ ] `sse/parsing.ts` created with SSE utilities
- [ ] All imports updated
- [ ] SSE streaming behavior unchanged
- [ ] Tests created/moved
- [ ] All tests pass
- [ ] Functions removed from `provider-utils.ts`

## Risk Assessment

**Risk Level:** Medium

- SSE parsing is critical for streaming responses
- Edge cases in line parsing could break streaming
- Runtime behavior not caught by TypeScript

## Estimated Time

2 hours
