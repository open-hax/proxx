---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-opencode-lite-mcp-opencode-lite-md"
title: "Sub-spec: opencode-lite sessions/messages with Postgres"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.188Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/opencode-lite-mcp--opencode-lite.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/opencode-lite-mcp--opencode-lite.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/opencode-lite-mcp--opencode-lite.md`

# Sub-spec: opencode-lite sessions/messages with Postgres

**Epic:** `opencode-lite-mcp-epic.md`
**SP:** 5
**Priority:** P3
**Depends on:** nothing

## Scope
Implement the minimum OpenCode/OpenAPI subset required by OpenPlanner/workbench, backed by Postgres.

### Storage
```sql
CREATE TABLE opencode_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  prompt_cache_key TEXT
);

CREATE TABLE opencode_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES opencode_sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  reasoning_content TEXT,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Endpoints
- `GET /session` — list sessions
- `GET /session/:sessionID` — get session
- `GET /session/status` — minimal status
- `GET /session/:sessionID/message` — list messages
- `POST /session/:sessionID/message` — create message
- `GET /session/:sessionID/message/:messageID` — get message
- `POST /session/:sessionID/prompt_async` — queued prompt (stub initially)

### Verification
- `@promethean-os/opencode-cljs-client` can list sessions
- Messages are persisted to Postgres
- All state is Postgres-backed (no sqlite)

## Related
- `proxx-openplanner-integration.md` — OpenPlanner as data lake
- `proxx-mcp-gateway.md` — MCP gateway
