---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-openplanner-integration-proxy-registry-md"
title: "Sub-spec: Lake proxy + registry"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.185Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/openplanner-integration--proxy-registry.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/openplanner-integration--proxy-registry.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/openplanner-integration--proxy-registry.md`

# Sub-spec: Lake proxy + registry

**Epic:** `openplanner-integration-epic.md`
**SP:** 5
**Priority:** P3
**Depends on:** nothing

## Scope
Implement the OpenPlanner registry and reverse proxy at `/api/v1/lake/*`.

### New files
- `src/lib/lake-registry.ts` — `OpenPlannerRegistry` class (health check, stats)
- `src/lib/lake-proxy.ts` — reverse proxy logic for OpenPlanner traffic

### Changes
- `src/routes/api/v1/index.ts` — register lake routes
- New `src/routes/lake/index.ts` — proxy router for `/api/v1/lake/*`
- `docker-compose.yml` — add OpenPlanner + ChromaDB services
- OpenPlanner — remove standalone auth, bind to compose network

### Proxied endpoints
- `POST /api/v1/lake/events` — ingest events
- `POST /api/v1/lake/search/fts` — full-text search
- `POST /api/v1/lake/search/vector` — vector/semantic search
- `GET /api/v1/lake/sessions` — list sessions
- `GET /api/v1/lake/sessions/:id` — get session
- `POST /api/v1/lake/blobs` — upload blobs
- `GET /api/v1/lake/blobs/:sha256` — retrieve blobs

## Verification
- `POST /api/v1/lake/events` proxies to OpenPlanner
- `GET /api/v1/lake/health` returns OpenPlanner status
- Unauthenticated requests return 401
