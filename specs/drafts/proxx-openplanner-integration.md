# Proxx OpenPlanner Integration

## Status
Draft

## Summary
Integrate OpenPlanner as the canonical session data lake behind proxx, replacing proxx's local Chroma-based session storage with OpenPlanner's full-featured search surface (DuckDB/MongoDB + ChromaDB vector search + FTS).

## Problem statement
Proxx currently manages sessions through:
- Local ChromaDB for semantic search
- File-based request logs (`data/request-logs.jsonl`)
- No structured event ingestion pipeline
- No blob storage for session artifacts
- No FTS search across session content

OpenPlanner (`services/openplanner`) already provides:
- DuckDB (default) or MongoDB for structured event storage
- ChromaDB for vector/semantic search
- FTS search via DuckDB
- Blob storage with SHA256 addressing
- Import jobs (ChatGPT data, etc.)
- Semantic compaction pipeline

Both run separately with their own auth and API surfaces. This spec defines how proxx integrates OpenPlanner as its data lake backend.

## Goals
1. Proxy OpenPlanner's API surface through proxx at `/api/v1/lake/*`.
2. Replace proxx's local Chroma session search with OpenPlanner's search endpoints.
3. Route event ingestion through OpenPlanner for all proxx request logs.
4. Unify auth: proxx handles authentication, OpenPlanner trusts proxx.
5. Co-deploy OpenPlanner + ChromaDB with proxx via compose.
6. Expose OpenPlanner management (health, config, stats) via proxx control plane.

## Non-goals
- Rewriting OpenPlanner's storage backends or search logic.
- Migrating existing DuckDB/MongoDB deployments.
- Changing OpenPlanner's internal API contract.
- Managing non-lake services through this surface.

## Architecture

### Surface 1: Lake data-plane proxy
Proxx proxies OpenPlanner's API surface for session search, event ingestion, and analytics.

Prefix:
- `/api/v1/lake/*`

Endpoints (proxied from OpenPlanner):
- `POST /api/v1/lake/events` — ingest events into the data lake
- `POST /api/v1/lake/search/fts` — full-text search across sessions
- `POST /api/v1/lake/search/vector` — vector/semantic search
- `GET /api/v1/lake/sessions` — list sessions
- `GET /api/v1/lake/sessions/:id` — get a specific session
- `POST /api/v1/lake/blobs` — upload binary blobs
- `GET /api/v1/lake/blobs/:sha256` — retrieve blobs
- `POST /api/v1/lake/jobs/import/chatgpt` — import ChatGPT data

Rules:
- proxx handles auth, OpenPlanner trusts proxx
- OpenPlanner binds to localhost only within the compose network
- proxx adds `X-Tenant-Id` header for multi-tenant event segregation
- existing proxx session search (`/api/v1/sessions/*`) progressively delegates to OpenPlanner

### Surface 2: Lake control-plane API
Management surface for OpenPlanner lifecycle and configuration.

Prefix:
- `/api/v1/lake/*` (management endpoints)

Endpoints:
- `GET /api/v1/lake/health` — OpenPlanner health and storage status
- `GET /api/v1/lake/config` — OpenPlanner configuration
- `PUT /api/v1/lake/config` — update OpenPlanner configuration
- `GET /api/v1/lake/stats` — session count, event count, storage usage
- `POST /api/v1/lake/compact` — trigger semantic compaction run
- `GET /api/v1/lake/jobs` — list import/export jobs
- `POST /api/v1/lake/start` — start OpenPlanner
- `POST /api/v1/lake/stop` — stop OpenPlanner
- `POST /api/v1/lake/restart` — restart OpenPlanner
- `GET /api/v1/lake/logs` — tail OpenPlanner logs

Rules:
- all endpoints require `PROXY_AUTH_TOKEN` or valid tenant API key
- config updates are persisted to proxx's SQL store
- OpenPlanner is a single canonical instance per host (not a fleet like MCP servers)

### Surface 3: OpenPlanner config contract
OpenPlanner implements a standardized management surface.

OpenPlanner MUST expose (or proxx wraps):
- `GET /health` — already exists, returns `{ ok, name, version, storageBackend }`
- `GET /api/config` — current storage backend, embedding model, compaction settings
- `PUT /api/config` — update runtime settings (embedding models, compaction knobs, TTL)

Standard config envelope:
```json
{
  "server": "openplanner",
  "version": "0.2.0",
  "config": {
    "storageBackend": "duckdb" | "mongodb",
    "embeddingModel": "nomic-embed-text:latest",
    "compaction": { "enabled": true, "charBudget": 8000 },
    "ttl": { "eventsSeconds": 0, "compactedSeconds": 0 }
  },
  "schema": { ... }
}
```

## OpenPlanner registry

OpenPlanner is a single canonical instance per host:

```typescript
interface OpenPlannerDescriptor {
  id: "openplanner";
  baseUrl: string;         // internal URL, e.g. http://openplanner:7777
  localPort: number;       // 7777
  storageBackend: "duckdb" | "mongodb";
  chromaUrl: string;       // ChromaDB endpoint
  status: "running" | "stopped" | "unhealthy" | "unknown";
  stats?: {
    sessionCount: number;
    eventCount: number;
    vectorCount: number;
    storageBytes: number;
  };
}
```

## Auth model

### Current state
- OpenPlanner: `OPENPLANNER_API_KEY` static bearer token

### Target state
- Proxx is the single auth gate for all lake traffic
- OpenPlanner binds to `127.0.0.1` or compose internal network only
- Proxx forwards authenticated requests with `X-Forwarded-User` and `X-Tenant-Id` headers
- OpenPlanner trusts localhost/internal requests from proxx (no additional auth needed)

## Deployment

### Compose stack
OpenPlanner + ChromaDB run in the same compose project as proxx:

```yaml
services:
  proxx:
    # existing proxx service
    ports:
      - "8789:8789"
    networks:
      - gateway
    depends_on:
      - openplanner

  openplanner:
    build: ../../services/openplanner
    networks:
      - gateway
    volumes:
      - openplanner-data:/data
    environment:
      - OPENPLANNER_STORAGE_BACKEND=duckdb
      - CHROMA_URL=http://chroma:8000

  chroma:
    image: chromadb/chroma
    networks:
      - gateway
    volumes:
      - chroma-data:/chroma
```

### Host placement
- OpenPlanner deploys to the same hosts as proxx (ussy, ussy2, ussy3, big.ussy)
- `OPENPLANNER_ENABLED` env var on proxx controls registration (default: true)
- Resource-constrained hosts can disable OpenPlanner via compose profiles

### Data volumes
- OpenPlanner: DuckDB files + blob storage on host volume
- ChromaDB: vector data on host volume
- Proxx: SQL database (PostgreSQL) for config, credentials, and lake registry

## Session search migration

### Current state
Proxx uses local ChromaDB for semantic session search:
- Embeddings generated via Ollama
- Stored in local Chroma collection
- Searched via `/api/v1/sessions` endpoints

### Target state
Proxx delegates all session search to OpenPlanner:
- Request logs are ingested as events via `POST /api/v1/lake/events`
- Sessions are stored in OpenPlanner's DuckDB/MongoDB
- Semantic search uses OpenPlanner's ChromaDB-backed vector search
- FTS search uses OpenPlanner's DuckDB FTS
- Proxx's `/api/v1/sessions/*` routes become thin proxies to OpenPlanner

### Migration path
1. Dual-write: proxx writes to both local Chroma and OpenPlanner events
2. Read-switch: proxx reads from OpenPlanner, writes still dual
3. Local deprecation: proxx stops writing to local Chroma
4. Cleanup: local Chroma dependency removed from proxx

## Affected files

### Proxx changes
- `src/routes/lake/index.ts` — new: OpenPlanner proxy router
- `src/routes/api/v1/index.ts` — add lake control-plane route registration
- `src/lib/lake-registry.ts` — new: OpenPlanner registry and health manager
- `src/lib/lake-proxy.ts` — new: reverse proxy logic for OpenPlanner traffic
- `src/lib/lake-config.ts` — new: OpenPlanner config persistence
- `src/lib/session-search.ts` — delegate to OpenPlanner search instead of local Chroma
- `src/lib/request-logger.ts` — ingest events into OpenPlanner instead of local file
- `docker-compose.yml` — add OpenPlanner + Chroma services
- `web/src/pages/DataLake.tsx` — new: OpenPlanner management UI page
- `web/src/pages/Sessions.tsx` — update to use OpenPlanner search backend

### OpenPlanner changes
- Add standardized `/api/config` GET/PUT endpoints for runtime settings
- Remove standalone auth (trust proxx instead)
- Bind to compose internal network only
- Add `/api/stats` endpoint for session/event/vector counts

## Phases

### Phase 1: Proxy + Registry
- Implement `OpenPlannerRegistry` class in proxx
- Implement reverse proxy at `/api/v1/lake/*` to OpenPlanner
- Add `/api/v1/lake/health` endpoint
- Update OpenPlanner to remove standalone auth
- Add OpenPlanner + Chroma to proxx compose stack

### Phase 2: Config Management
- Implement `/api/v1/lake/config` GET/PUT
- Add config persistence to proxx SQL store
- Build OpenPlanner config UI in web console
- Add `/api/v1/lake/stats` endpoint

### Phase 3: Lifecycle Management
- Implement OpenPlanner start/stop/restart via compose integration
- Add `/api/v1/lake/logs` endpoint
- Implement auto-restart policies
- Add OpenPlanner status to web console dashboard

### Phase 4: Session Search Migration
- Dual-write: proxx ingests events into OpenPlanner while keeping local Chroma
- Read-switch: proxx session search delegates to OpenPlanner
- Update `/api/v1/sessions/*` routes to proxy OpenPlanner search
- Update web console session search page to use OpenPlanner
- Deprecate local Chroma dependency in proxx

### Phase 5: Fleet-Wide Lake
- Register remote OpenPlanner instances from host dashboard targets
- Support cross-host session search across fleet
- Implement OpenPlanner deployment via compose push

## Verification
- `POST /api/v1/lake/events` proxies to OpenPlanner and ingests events
- `POST /api/v1/lake/search/vector` proxies to OpenPlanner and returns vector results
- `GET /api/v1/lake/health` returns OpenPlanner status with storage backend info
- `GET /api/v1/lake/stats` returns session/event/vector counts
- `GET /api/v1/sessions` returns sessions from OpenPlanner backend
- Unauthenticated requests to `/api/v1/lake/*` return 401
- Web console shows Data Lake page with OpenPlanner status and search
- Session search in proxx chat page uses OpenPlanner backend

## Definition of done
- OpenPlanner is registered and proxied at `/api/v1/lake/*`
- OpenPlanner no longer handles its own auth
- `/api/v1/lake/*` provides full OpenPlanner management and search
- Proxx's local Chroma session search delegates to OpenPlanner
- Web console has Data Lake management UI page
- Compose stack deploys proxx + OpenPlanner + Chroma together
- Fleet hosts can run OpenPlanner with proxx as gateway

## Risks
- OpenPlanner DuckDB file locking if multiple processes access the same database
- ChromaDB dependency in proxx during transition period (both local and OpenPlanner-backed)
- Backward compatibility for existing direct connections to OpenPlanner
- Embedding model consistency between proxx's local Chroma and OpenPlanner's Chroma
- Data migration for existing session history in proxx's local storage

## Related specs
- `proxx-mcp-gateway.md` — MCP server gateway integration behind proxx
