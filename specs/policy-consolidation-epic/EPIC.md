# Policy Consolidation Refactor Epic

**Epic ID:** POLICY-CONSOLIDATE-001
**Status:** Planning
**Total Points:** 16
**Estimated Timeline:** 2-3 sprints

## Problem Statement

The proxx codebase has policy logic scattered across multiple "helper" and "util" files, creating a dual-policy architecture where some routing decisions flow through `policy/engine/` while others bypass it. This makes the system harder to reason about, test, and extend.

## Goals

1. Consolidate all policy logic into `policy/` directory
2. Eliminate "helper" files containing policy decisions
3. Split "util" files into focused, single-responsibility modules
4. Improve discoverability and testability of routing rules

## Current State

**Files requiring refactor:**

| File | Lines | Issue | Target Location |
|------|-------|-------|-----------------|
| `defaults/gpt.ts` | 110 | Contains GPT, Claude, GLM, plan rules | `defaults/rules/` |
| `model-routing-helpers.ts` | 185 | Route filtering logic | `policy/adapters/` |
| `tenant-policy-helpers.ts` | 90 | Tenant enforcement | `policy/engine/` |
| `provider-utils.ts` | 568 | Mixed responsibilities | Split into 4 modules |
| `request-utils.ts` | 233 | Contains policy-adjacent functions | Move specific functions |

## Child Specs

### Phase 1: Policy Consolidation (7 points)

| Spec | Points | Priority | Dependencies |
|------|--------|----------|--------------|
| [1.1 Move Tenant Enforcement](./01-tenant-enforcement.md) | 2 | High | None |
| [1.2 Move Route Filtering](./02-route-filtering.md) | 2 | High | None |
| [1.3 Split Model Family Rules](./03-model-family-rules.md) | 3 | Medium | None |

### Phase 2: Utils Split (9 points)

| Spec | Points | Priority | Dependencies |
|------|--------|----------|--------------|
| [2.1 Extract HTTP Utilities](./04-http-utilities.md) | 2 | Medium | None |
| [2.2 Extract SSE Parsing](./05-sse-parsing.md) | 2 | Medium | 2.1 |
| [2.3 Extract Error Classification](./06-error-classification.md) | 2 | Medium | None |
| [2.4 Extract OpenAI Utilities](./07-openai-utilities.md) | 2 | Low | 2.1 |
| [2.5 Clean Request Utils](./08-request-utils-cleanup.md) | 1 | Low | None |

## Target Architecture

```
src/lib/policy/
├── adapters/
│   ├── model-info.ts         # (existing)
│   └── route-filtering.ts    # NEW: from model-routing-helpers
├── engine/
│   ├── account-ordering.ts   # (existing)
│   ├── provider-ordering.ts  # (existing)
│   ├── matchers.ts           # (existing)
│   ├── strategy-selection.ts # (existing)
│   └── tenant-enforcement.ts # NEW: from tenant-policy-helpers
├── defaults/
│   ├── index.ts              # (updated)
│   └── rules/                # NEW: from defaults/gpt.ts
│       ├── gpt.ts
│       ├── claude.ts
│       ├── glm.ts
│       ├── plans.ts
│       └── index.ts

src/lib/
├── http/
│   ├── fetch-utils.ts        # NEW: from provider-utils
│   └── url-utils.ts          # NEW: from provider-utils
├── sse/
│   └── parsing.ts            # NEW: from provider-utils
├── errors/
│   └── classification.ts     # NEW: from provider-utils
├── openai/
│   └── request-handling.ts   # NEW: from provider-utils, request-utils
└── provider-utils.ts         # REDUCED: only generic utilities
```

## Success Criteria

1. **No policy logic in helpers** - All moved to `policy/`
2. **No util files > 150 lines** - All split into focused modules
3. **All tests pass** - 579+ tests remain green
4. **Import paths intuitive** - `policy/engine/tenant-enforcement` vs `tenant-policy-helpers`
5. **Rule ordering documented** - GLM → Claude → GPT ordering explained

## Rollback Strategy

- Each child spec is independently deliverable
- Git tags after each: `policy-1.1-done`, `policy-1.2-done`, etc.
- Original files kept as `.bak` until tests pass
- Phase 1 and Phase 2 can be delivered separately

## Open Questions

1. Should `catalog-resolution.ts` live in `policy/` or stay in `lib/`?
2. Should `openai/` become `providers/openai/` for future expansion?
3. Should error classification be in `policy/engine/` since it affects routing?
