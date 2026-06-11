---
uuid: "15113daf-c5e7-4925-99b3-8eed4cb402a4"
title: "Sub-spec: MCP control-plane API + config management"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.135Z"
source: "kanban/drafts/epics/mcp-gateway--control-plane-config.md"
category: "specs"
---

> Source: `kanban/drafts/epics/mcp-gateway--control-plane-config.md`
> Migrated-to-kanban: `kanban/drafts/epics/mcp-gateway--control-plane-config.md`

# Sub-spec: MCP control-plane API + config management

**Epic:** `mcp-gateway-epic.md`
**SP:** 3
**Priority:** P3
**Depends on:** `mcp-gateway--registry-proxy.md`

## Scope
Implement the MCP control-plane endpoints for server management and configuration.

### Endpoints
- `GET /api/v1/mcp/:id` — server details, config, health
- `POST /api/v1/mcp/:id/start` — start server
- `POST /api/v1/mcp/:id/stop` — stop server
- `POST /api/v1/mcp/:id/restart` — restart server
- `GET /api/v1/mcp/:id/logs` — tail server logs
- `GET /api/v1/mcp/:id/config` — get server configuration
- `PUT /api/v1/mcp/:id/config` — update server configuration (persisted to SQL)

### New files
- `src/lib/mcp-config.ts` — config persistence and schema validation

### Changes
- `src/routes/mcp/index.ts` — add control-plane route handlers
- Web console — add MCP management page to settings

## Verification
- `POST /api/v1/mcp/social-publisher/start` starts the server
- `PUT /api/v1/mcp/social-publisher/config` persists config
- All endpoints require auth
