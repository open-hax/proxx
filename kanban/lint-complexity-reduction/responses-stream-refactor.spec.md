---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-lint-complexity-reduction-responses-stream-refactor-spec-md"
title: "Spec: responses-compat.ts Refactor"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.159Z"
source: "orgs/open-hax/proxx/specs/lint-complexity-reduction/responses-stream-refactor.spec.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/lint-complexity-reduction/responses-stream-refactor.spec.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/lint-complexity-reduction/responses-stream-refactor.spec.md`

# Spec: responses-compat.ts Refactor

**Status:** OBSOLETE — partially addressed by `specs/drafts/epics/reasoning-equivalence-epic.md`

## Historical Reference
Original goal: Refactor `processEvent` (cyclomatic complexity 67) in `responses-compat.ts` into a registry pattern.

## Resolution
The reasoning-equivalence epic addresses the streaming equivalence issues that this spec identified. The specific event handler registry pattern has not been implemented, but the file-level complexity has been addressed through other extractions.

See `specs/drafts/epics/reasoning-equivalence-epic.md` for the authoritative tracker.
