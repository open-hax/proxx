---
uuid: "c1c0ff2d-ca04-4c05-9b89-e5bd506d8b67"
title: "Epic: OpenPlanner + opencode-lite + MCP tool gateway"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.145Z"
source: "kanban/drafts/epics/opencode-lite-mcp-epic.md"
category: "specs"
---

> Source: `kanban/drafts/epics/opencode-lite-mcp-epic.md`
> Migrated-to-kanban: `kanban/drafts/epics/opencode-lite-mcp-epic.md`

# Epic: OpenPlanner + opencode-lite + MCP tool gateway

**Status:** Draft
**Epic SP:** 8 (broken into 3 sub-specs ≤5 SP each)
**Priority:** P3
**Parent file:** `kanban/drafts/openplanner-opencode-lite-and-mcp-tools.md`

## Sub-specs

| # | Sub-spec | SP | File |
|---|----------|----|------|
| 1 | opencode-lite sessions/messages with Postgres | 5 | `epics/opencode-lite-mcp--opencode-lite.md` |
| 2 | MCP tool discovery + smoke tests | 3 | `epics/opencode-lite-mcp--tool-discovery.md` |
| 3 | Agent loop + UI integration | 3 | `epics/opencode-lite-mcp--agent-loop.md` |

## Execution order
1 → 2 → 3 (sequential)

## Definition of done
- Workbench can call opencode-lite `/session` and get stable titles
- Proxy UI can list MCP servers and run health checks
- At least one MCP tool can be invoked end-to-end from the proxy UI
- All state persisted in Postgres (no sqlite, no local JSON)
