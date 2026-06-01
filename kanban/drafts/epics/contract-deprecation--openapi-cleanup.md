---
uuid: "e64ed214-d616-4960-be54-4a378bcc983c"
title: "Sub-spec: OpenAPI ownership + ui-routes.ts removal"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.136Z"
source: "kanban/drafts/epics/contract-deprecation--openapi-cleanup.md"
category: "specs"
---

> Source: `kanban/drafts/epics/contract-deprecation--openapi-cleanup.md`
> Migrated-to-kanban: `kanban/drafts/epics/contract-deprecation--openapi-cleanup.md`

# Sub-spec: OpenAPI ownership + ui-routes.ts removal

**Epic:** `contract-deprecation-epic.md`
**Epic SP:** 2
**Priority:** P0
**Status:** ✅ Done

## What was done
- Deleted `src/lib/ui-routes.ts` (62-line monolith barrel)
- Replaced `registerUiRoutes` with `registerWebSocketRoutes` + `registerApiV1Routes` in `app.ts`
- Migrated 57 test URLs from `/api/ui/*` to `/api/v1/*` across 3 test files
- All advanced federation routes now available at `/api/v1/federation/*`
- 162/162 proxy tests pass, container healthy
- Parity confirmed: existing proxy.test.ts exercises both `/api/ui/*` and `/api/v1/*` endpoints
- Deprecation headers verified live via curl
