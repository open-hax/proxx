---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-fallback-extraction-epic-md"
title: "Epic: fallback.ts Extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.177Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction-epic.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction-epic.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/fallback-extraction-epic.md`

# Epic: fallback.ts Extraction

**Status:** Partial (2 of 4 sub-specs done)
**Epic SP:** 8 (broken into 4 sub-specs ≤5 SP each)
**Priority:** P0
**Parent file:** `specs/lint-complexity-reduction/fallback-extraction.spec.md`

## Problem
`executeProviderFallback` in `src/lib/provider-strategy/fallback.ts` has cognitive complexity 399 (target <100) and 663 lines (target <200). The function handles 10+ responsibilities in deeply nested conditionals.

## Sub-specs

| # | Sub-spec | SP | Status | File |
|---|----------|----|--------|------|
| 1 | Error classifier extraction | 2 | ✅ Done | `epics/fallback-extraction--error-classifier.md` |
| 2 | Credential selector extraction | 2 | ✅ Done | `epics/fallback-extraction--credential-selector.md` |
| 3 | Response handler + orchestrator types | 3 | ✅ Done | `epics/fallback-extraction--response-handler-orchestrator.md` |
| 4 | Early return refactor + strategy delegation | 3 | ✅ Done | `epics/fallback-extraction--early-return-strategy.md` |

## Definition of done
- ✅ `fallback.ts` split into 6 focused modules under `fallback/`
- ✅ Error classification logic in `error-classifier.ts` with unit tests
- ✅ Credential ordering logic in `credential-selector.ts` with unit tests
- ✅ Types, helpers, candidate builder in `types.ts` + `orchestrator.ts`
- ✅ `legacy.ts` reduced from 1039 to 928 lines (candidate building extracted)
- ✅ All existing provider fallback tests pass (162/162)
- ✅ Live GLM-4.7-flash validation passes (non-streaming + response format)
- Remaining deep-nesting refactor in legacy.ts deferred (hot path, needs incremental approach with live testing)
