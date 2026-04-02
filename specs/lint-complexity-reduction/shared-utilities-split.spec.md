# Spec: shared.ts Utilities Split

**Status:** OBSOLETE — partially addressed by `specs/drafts/epics/fallback-extraction-epic.md`

## Historical Reference
Original goal: Split `shared.ts` into domain modules (credential-selection, request-building, response-handling, error-classification).

## Resolution
The fallback-extraction epic extracted credential-selector.ts, error-classifier.ts, orchestrator.ts, and types.ts from the fallback module. The remaining shared.ts concerns are lower priority and the specific plan is outdated.

See `specs/drafts/epics/fallback-extraction-epic.md` for the authoritative tracker.
