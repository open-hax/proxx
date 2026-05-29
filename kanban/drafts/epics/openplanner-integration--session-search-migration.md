---
uuid: "inbox-worktrees-proxx-pr-156-coderabbit-kanban-inbox-worktrees-proxx-pr-156-coderabbit-specs-drafts-epics-openplanner-integration-session-search-migration-md"
title: "Sub-spec: Session search migration"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.143Z"
source: "inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/epics/openplanner-integration--session-search-migration.md"
category: "specs"
---

> Source: `inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/epics/openplanner-integration--session-search-migration.md`
> Migrated-to-kanban: `inbox/worktrees/proxx-pr-156-coderabbit/kanban/drafts/epics/openplanner-integration--session-search-migration.md`

# Sub-spec: Session search migration

**Epic:** `openplanner-integration-epic.md`
**SP:** 3
**Priority:** P3
**Depends on:** `openplanner-integration--config-lifecycle.md`

## Scope
Migrate proxx's session search from local ChromaDB to OpenPlanner.

### Migration path
1. **Dual-write**: proxx ingests events into both local Chroma and OpenPlanner
2. **Read-switch**: `/api/v1/sessions/*` reads from OpenPlanner, writes still dual
3. **Local deprecation**: stop writing to local Chroma
4. **Cleanup**: remove Chroma dependency

### Changes
- `src/lib/session-search.ts` — delegate to OpenPlanner search instead of local Chroma
- `src/lib/request-logger.ts` — ingest events into OpenPlanner
- `src/routes/sessions/*` — thin proxy to OpenPlanner search
- Web console — update sessions page to use OpenPlanner backend

## Verification
- `GET /api/v1/sessions` returns sessions from OpenPlanner
- Semantic search results match or exceed local Chroma quality
- Dual-write phase has no data loss
