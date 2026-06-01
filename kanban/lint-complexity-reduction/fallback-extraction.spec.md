---
uuid: "7fbcd8fd-511e-43e0-ba81-557da4c1bc5c"
title: "Spec: fallback.ts Extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.115Z"
source: "kanban/lint-complexity-reduction/fallback-extraction.spec.md"
category: "specs"
---

> Source: `kanban/lint-complexity-reduction/fallback-extraction.spec.md`
> Migrated-to-kanban: `kanban/lint-complexity-reduction/fallback-extraction.spec.md`

# Spec: fallback.ts Extraction

**Status:** OBSOLETE — superseded by `kanban/drafts/epics/fallback-extraction-epic.md` (all 4 sub-specs done)

## Historical Reference
Original problem: `executeProviderFallback` had cyclomatic complexity 154, cognitive complexity 399, 663 lines.

## Resolution
Extracted into 6 focused modules under `src/lib/provider-strategy/fallback/`:
- `error-classifier.ts` — error classification logic
- `credential-selector.ts` — credential ordering and selection
- `orchestrator.ts` — candidate building
- `types.ts` — FallbackDeps, helpers
- `legacy.ts` — main fallback loop (reduced)
- `index.ts` — barrel exports

See `epics/fallback-extraction-epic.md` for the authoritative tracker.
