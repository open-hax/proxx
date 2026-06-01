---
uuid: "d0275c6b-c4bf-43d6-bf7d-13485c12695e"
title: "Sub-spec: MCP lifecycle + tool discovery"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.143Z"
source: "kanban/drafts/epics/mcp-gateway--lifecycle-tools.md"
category: "specs"
---

> Source: `kanban/drafts/epics/mcp-gateway--lifecycle-tools.md`
> Migrated-to-kanban: `kanban/drafts/epics/mcp-gateway--lifecycle-tools.md`

# Sub-spec: MCP lifecycle + tool discovery

**Epic:** `mcp-gateway-epic.md`
**SP:** 3
**Priority:** P3
**Depends on:** `mcp-gateway--control-plane-config.md`

## Scope
Add tool discovery and invocation endpoints, plus auto-restart policies.

### Endpoints
- `GET /api/v1/mcp/:id/tools` — list available MCP tools (calls `tools/list` on backend)
- `POST /api/v1/mcp/:id/call` — call a specific tool by name

### Changes
- Auto-restart policy: if a server health check fails, proxx restarts it
- Fleet registration: discover MCP servers from host dashboard targets (remote hosts)
- Web console: tool browser UI for browsing and invoking MCP tools

## Verification
- `GET /api/v1/mcp/social-publisher/tools` returns tool schemas from backend
- `POST /api/v1/mcp/social-publisher/call` invokes a tool and returns result
- Failed health checks trigger auto-restart
