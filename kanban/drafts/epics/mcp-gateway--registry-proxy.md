---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-mcp-gateway-registry-proxy-md"
title: "Sub-spec: MCP registry + proxy core"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.191Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/mcp-gateway--registry-proxy.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/mcp-gateway--registry-proxy.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/mcp-gateway--registry-proxy.md`

# Sub-spec: MCP registry + proxy core

**Epic:** `mcp-gateway-epic.md`
**SP:** 5
**Priority:** P3
**Depends on:** nothing

## Scope
Implement the MCP server registry and reverse proxy that routes `/mcp/<server-name>/*` to backend MCP servers.

### New files
- `src/lib/mcp-registry.ts` — `McpServerRegistry` class that discovers servers from compose/PM2, tracks health
- `src/lib/mcp-proxy.ts` — reverse proxy logic for MCP traffic (Streamable HTTP + SSE passthrough)

### Changes
- `src/routes/mcp/index.ts` — implement proxy router (currently empty stub) that routes `/mcp/:serverName/*`
- `src/routes/api/v1/index.ts` — register MCP control-plane routes (list endpoint)
- `docker-compose.yml` — add `mcp-social-publisher` as first co-deployed MCP server
- `mcp-social-publisher` — add `/health` endpoint, bind to localhost/private network only, and reject direct traffic that does not carry proxy-issued internal auth

### Auth
- Proxx handles auth (bearer token or tenant API key)
- Backend servers must be network-isolated (localhost bind, private bridge network, or equivalent firewall policy) so `/mcp/*` backends are not directly reachable
- Proxx strips any inbound `X-Forwarded-User` / `X-Tenant-Id` headers, reissues trusted values itself, and attaches an internal auth credential (shared header or mTLS identity)
- Backend servers trust proxx only after verifying that internal auth credential
- Unauthenticated requests to `/mcp/*` return 401

## Verification
- `GET /mcp/social-publisher/mcp` proxies to backend and returns MCP protocol response
- `GET /api/v1/mcp` returns registered servers with status
- Unauthenticated requests return 401
