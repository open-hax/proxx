---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-lint-complexity-reduction-shared-utilities-split-spec-md"
title: "Spec: shared.ts Utilities Split"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.160Z"
source: "orgs/open-hax/proxx/specs/lint-complexity-reduction/shared-utilities-split.spec.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/lint-complexity-reduction/shared-utilities-split.spec.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/lint-complexity-reduction/shared-utilities-split.spec.md`

# Spec: shared.ts Utilities Split

**Status:** OBSOLETE — partially addressed by `specs/drafts/epics/fallback-extraction-epic.md`

## Historical Reference
Original goal: Split `shared.ts` into domain modules (credential-selection, request-building, response-handling, error-classification).

## Resolution
The fallback-extraction epic extracted credential-selector.ts, error-classifier.ts, orchestrator.ts, and types.ts from the fallback module. The remaining shared.ts concerns are lower priority and the specific plan is outdated.

See `specs/drafts/epics/fallback-extraction-epic.md` for the authoritative tracker.
