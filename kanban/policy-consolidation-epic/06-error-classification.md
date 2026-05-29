---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-policy-consolidation-epic-06-error-classification-md"
title: "Spec 2.3: Extract Error Classification"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.163Z"
source: "orgs/open-hax/proxx/specs/policy-consolidation-epic/06-error-classification.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/policy-consolidation-epic/06-error-classification.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/policy-consolidation-epic/06-error-classification.md`

# Spec 2.3: Extract Error Classification

**Spec ID:** POLICY-CONSOLIDATE-001-06
**Epic:** [Policy Consolidation](./EPIC.md)
**Points:** 2
**Priority:** Medium
**Dependencies:** None

## Objective

Extract error classification and retry decision logic from `provider-utils.ts` into dedicated `errors/` module.

## Current Location

`src/lib/provider-utils.ts` (568 lines, extracting ~120 lines)

## Target Location

`src/lib/errors/classification.ts`

## Functions to Extract

| Function | Lines | Purpose |
|----------|-------|---------|
| `shouldRetrySameCredentialForServerError` | ~15 | Retry decision for server errors |
| `shouldCooldownCredentialOnAuthFailure` | ~15 | Cooldown decision for auth failures |
| `shouldPermanentlyDisableCredential` | ~15 | Permanent disable decision |
| `classifyUpstreamError` | ~30 | Classify error type from response |
| `isRetryableError` | ~15 | Check if error is retryable |
| `toErrorMessage` | ~10 | Convert error to message string |

## Implementation Steps

1. Create `src/lib/errors/` directory
2. Create `classification.ts` with error functions
3. Add index.ts for public exports
4. Update imports in fallback handlers:
   - `src/lib/provider-strategy/fallback/*.ts`
   - `src/lib/credential-manager.ts`
5. Run tests, verify fallback behavior unchanged
6. Run full test suite

## Import Changes

**Before:**
```typescript
import { shouldRetrySameCredentialForServerError, classifyUpstreamError } from "../provider-utils.js";
```

**After:**
```typescript
import { shouldRetrySameCredentialForServerError, classifyUpstreamError } from "../errors/classification.js";
```

## Test Updates

- Create `tests/errors/classification.test.ts`
- Test retry decision logic
- Test error classification
- Test permanent disable conditions

## Acceptance Criteria

- [ ] `errors/classification.ts` created
- [ ] All imports updated
- [ ] Fallback behavior unchanged
- [ ] Tests created
- [ ] All tests pass
- [ ] Functions removed from `provider-utils.ts`

## Risk Assessment

**Risk Level:** Medium

- Error classification affects fallback routing
- Retry decisions impact reliability
- Cooldown logic is timing-sensitive

## Estimated Time

2 hours
