# Spec 1.3: Split Model Family Rules

**Spec ID:** POLICY-CONSOLIDATE-001-03
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 3
**Priority:** Medium
**Dependencies:** None

## Objective

Split `defaults/gpt.ts` into separate files by model family to improve discoverability and maintainability. The current file incorrectly contains GPT, Claude, GLM, and plan rules in one place.

## Current Location

`src/lib/policy/defaults/gpt.ts` (110 lines)

## Target Location

`src/lib/policy/defaults/rules/` directory

## File Breakdown

### `rules/gpt.ts` (~40 lines)

**Exports:**
- `DEFAULT_GPT_PROVIDER_ORDER`
- `GPT_OSS_PROVIDER_ORDER`
- `GPT_FREE_BLOCKED_MODELS`
- `GPT_FREE_BLOCKED_MODEL_PATTERN`
- `createGptRoutingRules()`

**Rules:**
- GPT-OSS routing (`/^gpt-oss/`)
- GPT blocked models (free tier)
- GPT 6+ (requires paid)
- GPT general routing

### `rules/claude.ts` (~20 lines)

**Exports:**
- `CLAUDE_OPUS_46_PROVIDER_ORDER`
- `createClaudeRoutingRules()`

**Rules:**
- Claude Opus 4-6 routing

### `rules/glm.ts` (~20 lines)

**Exports:**
- `GLM_PROVIDER_ORDER`
- `createGlmRoutingRules()`

**Rules:**
- GLM family routing

### `rules/plans.ts` (~30 lines)

**Exports:**
- `PAID_PLAN_WEIGHTS`
- `PAID_PLANS`
- `buildFreeBlockedConstraints()`

**Purpose:**
- Plan tier weights
- Paid plan constraints

### `rules/index.ts` (~30 lines)

**Exports:**
- `createAllModelRoutingRules()` - Aggregates all rules in correct order
- Re-exports from individual files for backward compatibility

## Implementation Steps

1. Create `src/lib/policy/defaults/rules/` directory
2. Create `plans.ts` with plan-related exports
3. Create `gpt.ts` with GPT family rules
4. Create `claude.ts` with Claude rules
5. Create `glm.ts` with GLM rules
6. Create `index.ts` to aggregate and re-export
7. Update `defaults/index.ts` to use new structure
8. Run tests, verify rule ordering preserved
9. Delete original `gpt.ts`

## Critical: Rule Ordering

The aggregation in `index.ts` must preserve ordering:

```typescript
export function createAllModelRoutingRules(): readonly ModelRoutingRule[] {
  return [
    ...createGlmRoutingRules(),      // GLM first (most specific)
    ...createClaudeRoutingRules(),   // Claude next
    ...createGptRoutingRules(),      // GPT last (catches remaining)
  ];
}
```

**Why this order matters:**
- GLM patterns (`/^glm-/`) are most specific
- Claude patterns (`/^claude-opus-4-6/`) are highly specific
- GPT patterns (`/^gpt-/`) are catch-all for GPT family
- Order determines which rule matches first

## Import Changes

**Before:**
```typescript
import {
  DEFAULT_GPT_PROVIDER_ORDER,
  GLM_PROVIDER_ORDER,
  createGptModelRoutingRules
} from "../policy/defaults/gpt.js";
```

**After:**
```typescript
import {
  DEFAULT_GPT_PROVIDER_ORDER,
  GLM_PROVIDER_ORDER,
  createAllModelRoutingRules
} from "../policy/defaults/rules/index.js";
```

## Test Updates

- Create `tests/policy/rules/gpt.test.ts`
- Create `tests/policy/rules/claude.test.ts`
- Create `tests/policy/rules/glm.test.ts`
- Update `tests/policy.test.ts` to verify ordering
- Add test for `createAllModelRoutingRules()` ordering

## Acceptance Criteria

- [ ] Files created: `gpt.ts`, `claude.ts`, `glm.ts`, `plans.ts`, `index.ts`
- [ ] All rules properly migrated
- [ ] Rule ordering preserved (GLM → Claude → GPT)
- [ ] All imports updated
- [ ] All tests pass
- [ ] Original `gpt.ts` deleted
- [ ] No behavior changes

## Risk Assessment

**Risk Level:** Medium

- Rule ordering is critical for correct routing
- Multiple files to create and coordinate
- Test coverage needs expansion
- More complex than pure move operations

## Estimated Time

2-3 hours
