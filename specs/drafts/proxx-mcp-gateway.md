# Proxx MCP Gateway

## Status
Draft

## Summary
Turn `proxx` into a unified MCP gateway that manages, proxies, and standardizes all workspace MCP servers behind a single control surface.

## Problem statement
The workspace currently runs 9 independent MCP servers (`services/mcp-*`) plus additional ones in standalone repos. Each has:
- its own auth model (OAuth, static key, none)
- its own config format and settings surface
- its own deployment lifecycle
- no centralized discovery or management

Meanwhile, `proxx` already has:
- a `/v1/*` data-plane proxy surface for LLM routing
- an `/api/v1/*` control-plane API with auth, settings, and dashboard
- an empty MCP route stub at `src/routes/mcp/index.ts`
- a read-only seed scanner at `src/routes/api/ui/mcp/index.ts`
- a web console with a Tools/MCP page

The name "proxx" is generic enough to own the MCP gateway role. This spec defines how to make it real.

## Goals
1. Standardize a REST config/settings contract all MCP servers implement.
2. Proxy MCP traffic through proxx at `/mcp/<server-name>/*`.
3. Expose lifecycle management (health, start/stop, logs) via `/api/v1/mcp/*`.
4. Co-deploy MCP servers on the same hosts as proxx via compose.
5. Unify auth: proxx handles authentication, MCP servers trust proxx.
6. Replace the current seed-scanner with live server state.

## Non-goals
- Rewriting individual MCP server tool implementations.
- Replacing MCP protocol semantics (stdio/SSE/Streamable HTTP remain as-is per server).
- Managing non-MCP services through this surface.

## Architecture

### Surface 1: MCP data-plane proxy
Clients connect to proxx, which routes to backend MCP servers.

Prefix:
- `/mcp/<server-name>/*`

Examples:
- `POST /mcp/social-publisher/mcp`
- `GET /mcp/github/mcp`
- `POST /mcp/ollama/mcp`

Rules:
- proxx handles auth (bearer token from `PROXY_AUTH_TOKEN` or tenant API key)
- backend MCP servers bind to localhost only, trust proxx as reverse proxy
- transport is Streamable HTTP or SSE as each server supports
- proxx adds `X-MCP-Server-Id` header to downstream requests

### Surface 2: MCP control-plane API
Management surface for MCP server lifecycle and configuration.

Prefix:
- `/api/v1/mcp/*`

Endpoints:
- `GET /api/v1/mcp` — list all registered MCP servers with status
- `GET /api/v1/mcp/:id` — get server details, config, health
- `POST /api/v1/mcp/:id/start` — start a server
- `POST /api/v1/mcp/:id/stop` — stop a server
- `POST /api/v1/mcp/:id/restart` — restart a server
- `GET /api/v1/mcp/:id/logs` — tail server logs
- `GET /api/v1/mcp/:id/config` — get server configuration
- `PUT /api/v1/mcp/:id/config` — update server configuration
- `GET /api/v1/mcp/:id/tools` — list available MCP tools (calls `tools/list`)
- `POST /api/v1/mcp/:id/call` — call a specific tool by name

Rules:
- all endpoints require `PROXY_AUTH_TOKEN` or valid tenant API key
- config updates are persisted to proxx's SQL store or config file
- config schema is per-server but follows a standard envelope

### Surface 3: MCP server config contract
Each MCP server implements a standardized settings endpoint that proxx uses for management.

Every MCP server MUST expose:
- `GET /health` — health check returning `{ ok: boolean, server: string, version: string }`
- `GET /api/config` — current configuration (read-only for servers that don't support runtime config)
- `PUT /api/config` — update configuration (optional, servers can return 405 if config is env-only)

Standard config envelope:
```json
{
  "server": "mcp-social-publisher",
  "version": "0.1.0",
  "config": {
    "targets": { ... },
    "auth": { ... }
  },
  "schema": {
    "targets": { "type": "object", ... },
    "auth": { "type": "object", ... }
  }
}
```

## Server registry

Proxx maintains a registry of known MCP servers. Sources merge at runtime:

1. **Compose-managed** — servers defined in `docker-compose.yml` or override files
2. **PM2-managed** — servers managed via PM2 ecosystem files on the host
3. **Remote** — servers on other hosts in the fleet (via host dashboard targets)

Registry entry shape:
```typescript
interface McpServerDescriptor {
  id: string;              // e.g. "social-publisher", "github", "ollama"
  name: string;            // human-readable name
  version?: string;
  transport: "streamable-http" | "sse" | "stdio";
  baseUrl: string;         // internal URL proxx proxies to
  localPort?: number;      // port when co-located
  remoteHost?: string;     // host id when remote
  managedBy: "compose" | "pm2" | "remote" | "external";
  autoStart: boolean;
  status: "running" | "stopped" | "unhealthy" | "unknown";
  configSchema?: object;   // JSON Schema for config validation
}
```

## Auth model

### Current state
Each MCP server handles its own auth:
- `mcp-social-publisher`: MCP OAuth 2.1 + GitHub login
- Others: various (some none, some static keys)

### Target state
- Proxx is the single auth gate for all MCP traffic
- Backend MCP servers bind to `127.0.0.1` only
- Proxx forwards authenticated requests with `X-Forwarded-User` and `X-Tenant-Id` headers
- MCP servers trust localhost requests from proxx (no additional auth needed on backend)
- For external MCP clients that connect directly, proxx can issue short-lived bearer tokens

## Deployment

### Compose stack
All MCP servers run in the same compose project as proxx:

```yaml
services:
  proxx:
    # existing proxx service
    ports:
      - "8789:8789"
    networks:
      - mcp-gateway

  mcp-social-publisher:
    build: ../../services/mcp-social-publisher
    networks:
      - mcp-gateway
    # no ports exposed externally - proxx proxies internally

  mcp-github:
    build: ../../services/mcp-github
    networks:
      - mcp-gateway

  # ... other MCP servers
```

### Host placement
- MCP servers deploy to the same hosts as proxx (ussy, ussy2, ussy3, big.ussy)
- Resource-constrained hosts can selectively enable/disable MCP servers via compose profiles
- `MCP_ENABLED_SERVERS` env var on proxx controls which servers are registered

## Affected files

### Proxx changes
- `src/routes/mcp/index.ts` — implement proxy router (currently empty stub)
- `src/routes/api/v1/index.ts` — add MCP control-plane route registration
- `src/lib/mcp-registry.ts` — new: server registry manager
- `src/lib/mcp-proxy.ts` — new: reverse proxy logic for MCP traffic
- `src/lib/mcp-config.ts` — new: config persistence and validation
- `docker-compose.yml` — add MCP server services
- `web/src/pages/McpServers.tsx` — new: MCP management UI page

### MCP server changes (per server)
- Add standardized `/health` endpoint
- Add standardized `/api/config` GET/PUT endpoints (if runtime config needed)
- Remove standalone auth (trust proxx instead)
- Bind to `127.0.0.1` or compose internal network only

## Phases

### Phase 1: Registry + Proxy Core
- Implement `McpServerRegistry` class in proxx
- Implement reverse proxy at `/mcp/<server-name>/*`
- Add `/api/v1/mcp` list endpoint (read-only, from compose/PM2 discovery)
- Wire up health checking per server
- Update `mcp-social-publisher` as the first standardized server (health endpoint, remove standalone auth)

### Phase 2: Config Management
- Implement `/api/v1/mcp/:id/config` GET/PUT
- Add config persistence to proxx SQL store
- Implement config schema validation per server
- Build config UI in web console

### Phase 3: Lifecycle Management
- Implement start/stop/restart via compose/PM2 integration
- Add `/api/v1/mcp/:id/logs` endpoint
- Implement auto-restart policies
- Add server status dashboard to web console

### Phase 4: Tool Discovery + Invocation
- Implement `/api/v1/mcp/:id/tools` (calls `tools/list` on backend)
- Implement `/api/v1/mcp/:id/call` (calls `tools/call` on backend)
- Add tool browser to web console
- Support tool invocation from proxx chat page

### Phase 5: Fleet-Wide MCP
- Register remote MCP servers from host dashboard targets
- Support cross-host MCP routing
- Add fleet-wide tool discovery
- Implement MCP server deployment via compose push

## Verification
- `GET /mcp/social-publisher/mcp` proxies to backend and returns MCP protocol response
- `GET /api/v1/mcp` returns all registered servers with correct status
- `POST /api/v1/mcp/social-publisher/start` starts the server
- `PUT /api/v1/mcp/social-publisher/config` persists config and triggers server reload
- Unauthenticated requests to `/mcp/*` return 401
- Web console shows MCP server management page with live status

## Definition of done
- All 9 `services/mcp-*` servers are registered and proxied through proxx
- MCP servers no longer handle their own auth
- `/api/v1/mcp/*` provides full lifecycle management
- Web console has MCP server management UI
- Compose stack deploys proxx + MCP servers together
- Fleet hosts can run MCP servers with proxx as gateway

## Risks
- MCP protocol version drift between servers (Streamable HTTP vs SSE vs stdio)
- Some MCP servers may have complex config that doesn't fit the standard envelope
- Resource contention when running many MCP servers on the same host
- Backward compatibility for existing direct connections to MCP servers

## Related specs
- `proxx-openplanner-integration.md` — OpenPlanner integration as a data lake behind proxx
