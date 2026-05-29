---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-lint-complexity-reduction-fallback-extraction-spec-md"
title: "Spec: fallback.ts Extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.159Z"
source: "orgs/open-hax/proxx/specs/lint-complexity-reduction/fallback-extraction.spec.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/lint-complexity-reduction/fallback-extraction.spec.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/lint-complexity-reduction/fallback-extraction.spec.md`

# Spec: fallback.ts Extraction

**Status:** OBSOLETE — superseded by `specs/drafts/epics/fallback-extraction-epic.md` (all 4 sub-specs done)

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
