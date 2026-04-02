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
