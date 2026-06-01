---
uuid: "b14d9670-9c09-4b37-b3ad-7cf45d61a2a7"
title: "Sub-spec: MCP tool discovery + smoke tests"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.134Z"
source: "kanban/drafts/epics/opencode-lite-mcp--tool-discovery.md"
category: "specs"
---

> Source: `kanban/drafts/epics/opencode-lite-mcp--tool-discovery.md`
> Migrated-to-kanban: `kanban/drafts/epics/opencode-lite-mcp--tool-discovery.md`

# Sub-spec: MCP tool discovery + smoke tests

**Epic:** `opencode-lite-mcp-epic.md`
**SP:** 3
**Priority:** P3
**Depends on:** `opencode-lite-mcp--opencode-lite.md`

## Scope
Implement MCP tool discovery and invocation, starting with HTTP transport.

### Endpoints
- `GET /api/mcp/tools` — aggregate and cache tool schemas from all registered MCP servers
- `POST /api/mcp/tools/call` — execute a tool call on the target MCP server

### Discovery sources
- Existing seed listing from ecosystems (`/api/ui/mcp-servers`)
- MCP server registry from `mcp-gateway--registry-proxy.md` (when available)

### Transport
- Prefer HTTP MCP transport when `:PORT` is present
- Support legacy routing via `LEGACY_MCP_URL` if available

### Verification
- `GET /api/mcp/tools` returns tool schemas from at least one MCP server
- `POST /api/mcp/tools/call` invokes a tool and returns result
- Diagnostics route can test-connect all seeded MCP servers
