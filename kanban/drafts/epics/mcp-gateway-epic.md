---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-mcp-gateway-epic-md"
title: "Epic: Proxx MCP Gateway"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.183Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/mcp-gateway-epic.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/mcp-gateway-epic.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/mcp-gateway-epic.md`

# Epic: Proxx MCP Gateway

**Status:** Draft
**Epic SP:** 8 (broken into 3 sub-specs ≤5 SP each)
**Priority:** P3
**Parent file:** `specs/drafts/proxx-mcp-gateway.md`

## Sub-specs

| # | Sub-spec | SP | File |
|---|----------|----|------|
| 1 | MCP registry + proxy core | 5 | `epics/mcp-gateway--registry-proxy.md` |
| 2 | MCP control-plane API + config management | 3 | `epics/mcp-gateway--control-plane-config.md` |
| 3 | MCP lifecycle + tool discovery | 3 | `epics/mcp-gateway--lifecycle-tools.md` |

## Execution order
1 → 2 → 3 (sequential)

## Definition of done
- MCP servers registered and proxied through proxx at `/mcp/<server-name>/*`
- `/api/v1/mcp/*` provides lifecycle management
- MCP servers trust proxx auth, no standalone auth
- Web console has MCP server management UI
