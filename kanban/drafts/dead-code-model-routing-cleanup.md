---
uuid: "2d91b5a4-042b-423d-926a-6387aaa7417e"
title: "Spec: Dead code cleanup — model-selection-policies and provider-route-policies"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.150Z"
source: "kanban/drafts/dead-code-model-routing-cleanup.md"
category: "specs"
---

> Source: `kanban/drafts/dead-code-model-routing-cleanup.md`
> Migrated-to-kanban: `kanban/drafts/dead-code-model-routing-cleanup.md`

# Spec: Dead code cleanup — model-selection-policies and provider-route-policies

**Status:** Draft
**Story points:** 1
**Audit ref:** `kanban/audits/2026-04-02-ad-hoc-routing-code-audit.md` Finding 1

## Problem

Two files are never imported by any code in the repository:

- `src/lib/model-selection-policies.ts` (62 lines)
- `src/lib/provider-route-policies.ts` (170 lines)

Their functionality was absorbed into `src/lib/model-routing-helpers.ts`, but the originals were never deleted. Both contain functions that duplicate what `model-routing-helpers.ts` already exports.

## Scope

1. Delete `src/lib/model-selection-policies.ts`
2. Delete `src/lib/provider-route-policies.ts`
3. Verify no test files import them (grep confirms zero imports)
4. Run `pnpm build` and `npx tsx --test src/tests/model-routing-helpers.test.ts`

## Non-goals

- Refactoring the functions that remain in `model-routing-helpers.ts`
- Consolidating model family inference (that's a separate spec)

## Verification

- `pnpm build` passes
- Existing model-routing-helpers tests pass
- `rg "model-selection-policies|provider-route-policies" src/` returns zero results
