# Proxx Graph Surface

## Status
Draft

## Summary
Add `/api/v1/graph/*` to Proxx as the management and query surface for the Myrmex graph crawler. Proxx becomes the single entry point for graph operations: starting/stopping crawls, querying nodes and edges, traversing the graph, and checking crawl status.

## Problem statement
Myrmex runs as a background service that crawls the web and feeds content into OpenPlanner. Currently there's no way to:
- Start/stop/pause the crawler from the control plane
- Query the graph structure (nodes, edges, frontier)
- Check crawl status and statistics
- Traverse the graph programmatically
- Manage seed URLs

Proxx already has the pattern for proxying backend services (`/api/v1/lake/*` for OpenPlanner, `/api/v1/voice/*` for Voxx, `/mcp/*` for MCP servers). The graph surface follows the same pattern.

## Goals
1. Proxy Myrmex management API through Proxx at `/api/v1/graph/*`.
2. Expose graph query endpoints (nodes, edges, traverse, frontier).
3. Expose crawl lifecycle management (start/stop/pause/resume).
4. Unify auth: Proxx handles authentication, Myrmex trusts Proxx.
5. Add graph management page to Proxx web console.

## Non-goals
- Rewriting Myrmex's crawling logic or ACO algorithm.
- Storing graph state in Proxx (state lives in OpenPlanner).
- Building a standalone graph database in Proxx.

## Architecture

### Surface 1: Graph management API
Prefix:
- `/api/v1/graph/*`

Endpoints:
- `GET /api/v1/graph/stats` — graph statistics (nodes, edges, depth, freshness)
- `GET /api/v1/graph/nodes/:id` — get a specific node with content
- `GET /api/v1/graph/nodes/:id/edges` — get edges from a node
- `POST /api/v1/graph/traverse` — traverse the graph from a node (ACO-based)
- `GET /api/v1/graph/frontier` — current frontier state
- `POST /api/v1/graph/seed` — add seed URLs
- `GET /api/v1/graph/hosts` — per-host statistics and pacing
- `POST /api/v1/graph/crawl/start` — start the crawler
- `POST /api/v1/graph/crawl/stop` — stop the crawler
- `POST /api/v1/graph/crawl/pause` — pause crawling
- `POST /api/v1/graph/crawl/resume` — resume crawling
- `GET /api/v1/graph/crawl/status` — current crawl status

### Surface 2: Graph control-plane integration
Management endpoints for Myrmex lifecycle:
- `GET /api/v1/graph/health` — Myrmex health and backend status
- `GET /api/v1/graph/config` — Myrmex configuration
- `PUT /api/v1/graph/config` — update Myrmex configuration
- `POST /api/v1/graph/restart` — restart Myrmex
- `GET /api/v1/graph/logs` — tail Myrmex logs

## Auth model

### Target state
- Proxx is the single auth gate for all graph traffic
- Myrmex binds to compose internal network only
- Proxx forwards authenticated requests with `X-Forwarded-User` and `X-Tenant-Id`
- Myrmex trusts internal requests from Proxx

## Affected files

### Proxx changes
- `src/routes/graph/index.ts` — new: graph proxy router
- `src/routes/api/v1/index.ts` — add graph route registration
- `src/lib/graph-registry.ts` — new: Myrmex registry and health manager
- `src/lib/graph-proxy.ts` — new: reverse proxy logic for graph traffic
- `src/lib/graph-config.ts` — new: graph config persistence
- `web/src/pages/Graph.tsx` — new: graph management UI page

### Myrmex changes
- Expose management API at internal endpoints (health, config, stats, crawl control)
- Remove standalone auth (trust Proxx)
- Bind to compose internal network only

## Phases

### Phase 1: Proxy Router
- Implement graph proxy router at `/api/v1/graph/*`
- Add health and stats endpoints
- Wire up Myrmex registry

### Phase 2: Management Surface
- Add crawl lifecycle endpoints (start/stop/pause/resume)
- Add config GET/PUT endpoints
- Add graph query endpoints (nodes, edges, traverse, frontier)

### Phase 3: Web Console
- Build graph management UI page
- Add live crawl status dashboard
- Add graph visualization (nodes and edges)

## Verification
- `GET /api/v1/graph/stats` returns accurate node/edge counts
- `POST /api/v1/graph/crawl/start` begins crawling
- `GET /api/v1/graph/nodes/:id` returns node with content
- Unauthenticated requests to `/api/v1/graph/*` return 401
- Web console shows Graph page with live status

## Definition of done
- `/api/v1/graph/*` provides full graph management and query surface
- Myrmex no longer handles its own auth
- Web console has Graph management UI
- Compose stack deploys Proxx + Myrmex together

## Related specs
- `myrmex-orchestrator.md` — Myrmex orchestrator package
- `proxx-openplanner-integration.md` — OpenPlanner data lake integration
- `myrmex-graph-epic.md` — parent epic
