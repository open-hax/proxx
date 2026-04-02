# Proxx Voxx Integration

## Status
Draft

## Summary
Integrate Voxx as the canonical voice/audio service behind proxx, proxying TTS, STT, and voice management through the unified gateway surface.

## Problem statement
Voxx (`orgs/open-hax/voxx`) is a standalone voice gateway service providing:
- TTS with smart backend fallback (ElevenLabs → Requesty → OpenAI → Melo → espeak)
- STT via faster-whisper
- OpenAI-compatible audio endpoints (`/v1/audio/speech`, `/v1/audio/transcriptions`)
- ElevenLabs-compatible endpoints (`/v1/text-to-speech/*`, `/v1/speech-to-text/*`)
- Realtime WebSocket support for streaming TTS and STT
- Sports commentator audio postprocessing
- Transcript storage and retrieval

It runs independently with its own auth (`VOICE_GATEWAY_API_KEY`) and deployment pipeline. Proxx should own the gateway surface for voice just like it does for MCP servers and the data lake.

## Goals
1. Proxy Voxx's API surface through proxx at `/api/v1/voice/*`.
2. Unify auth: proxx handles authentication, Voxx trusts proxx.
3. Expose Voxx management (health, config, stats) via proxx control plane.
4. Co-deploy Voxx with proxx via compose.
5. Route LLM audio requests through proxx's voice surface.
6. Expose Voxx TTS as an MCP-callable tool through the MCP gateway.

## Non-goals
- Rewriting Voxx's TTS/STT backends or audio processing logic.
- Changing Voxx's internal API contract.
- Managing non-voice services through this surface.

## Architecture

### Surface 1: Voice data-plane proxy
Proxx proxies Voxx's API surface for TTS, STT, and voice management.

Prefix:
- `/api/v1/voice/*`

Endpoints (proxied from Voxx):
- `GET /api/v1/voice/models` — list available voice models
- `POST /api/v1/voice/speech` — TTS (OpenAI-compatible `/v1/audio/speech`)
- `POST /api/v1/voice/transcriptions` — STT (OpenAI-compatible `/v1/audio/transcriptions`)
- `POST /api/v1/voice/translations` — audio translation (OpenAI-compatible `/v1/audio/translations`)
- `GET /api/v1/voice/voices` — list voices (ElevenLabs-compatible)
- `GET /api/v1/voice/voices/:id` — get voice details
- `POST /api/v1/voice/tts/:voice_id` — TTS with specific voice (ElevenLabs-compatible)
- `POST /api/v1/voice/stt` — speech-to-text (ElevenLabs-compatible)
- `GET /api/v1/voice/stt/transcripts/:id` — get transcript by ID
- `WS /api/v1/voice/stt/realtime` — realtime STT WebSocket
- `WS /api/v1/voice/tts/:voice_id/stream-input` — realtime TTS WebSocket

Rules:
- proxx handles auth, Voxx trusts proxx
- Voxx binds to localhost only within the compose network
- proxx adds `X-Tenant-Id` header for multi-tenant usage tracking
- WebSocket connections are proxied with auth via query parameter

### Surface 2: Voice control-plane API
Management surface for Voxx lifecycle and configuration.

Prefix:
- `/api/v1/voice/*` (management endpoints)

Endpoints:
- `GET /api/v1/voice/health` — Voxx health and backend status
- `GET /api/v1/voice/config` — Voxx configuration (backend order, postprocess settings)
- `PUT /api/v1/voice/config` — update Voxx configuration
- `GET /api/v1/voice/stats` — usage stats (TTS requests, STT requests, backend distribution)
- `POST /api/v1/voice/start` — start Voxx
- `POST /api/v1/voice/stop` — stop Voxx
- `POST /api/v1/voice/restart` — restart Voxx
- `GET /api/v1/voice/logs` — tail Voxx logs
- `GET /api/v1/voice/backends` — list available TTS/STT backends with status
- `POST /api/v1/voice/backends/test` — test a specific backend

Rules:
- all endpoints require `PROXY_AUTH_TOKEN` or valid tenant API key
- config updates are persisted to proxx's SQL store
- Voxx is a single canonical instance per host

### Surface 3: Voxx config contract
Voxx implements a standardized management surface.

Voxx MUST expose (or proxx wraps):
- `GET /healthz` — already exists, returns `{ ok, service, requires_api_key, model_count }`
- `GET /api/config` — current backend order, postprocess settings, provider credentials status
- `PUT /api/config` — update runtime settings (backend order, timeouts, postprocess profile)

Standard config envelope:
```json
{
  "server": "voxx",
  "version": "0.1.0",
  "config": {
    "ttsBackendOrder": ["elevenlabs", "requesty", "openai", "melo", "espeak"],
    "postprocess": { "enabled": true, "profile": "sports-commentator-v1" },
    "defaultAudioFormat": "mp3",
    "providers": {
      "elevenlabs": { "configured": true },
      "requesty": { "configured": true },
      "openai": { "configured": true },
      "melo": { "configured": true },
      "espeak": { "configured": true }
    }
  },
  "schema": { ... }
}
```

## Voxx registry

Voxx is a single canonical instance per host:

```typescript
interface VoxxDescriptor {
  id: "voxx";
  baseUrl: string;         // internal URL, e.g. http://voxx:8788
  localPort: number;       // 8788
  status: "running" | "stopped" | "unhealthy" | "unknown";
  backends: {
    tts: Array<{ name: string; configured: boolean; healthy: boolean }>;
    stt: Array<{ name: string; configured: boolean; healthy: boolean }>;
  };
  stats?: {
    ttsRequestCount: number;
    sttRequestCount: number;
    backendDistribution: Record<string, number>;
    avgLatencyMs: number;
  };
}
```

## Auth model

### Current state
- Voxx: `VOICE_GATEWAY_API_KEY` with multiple auth styles (Bearer, x-api-key, xi-api-key, query param for WS)

### Target state
- Proxx is the single auth gate for all voice traffic
- Voxx binds to `127.0.0.1` or compose internal network only
- Proxx forwards authenticated requests with `X-Forwarded-User` and `X-Tenant-Id` headers
- Voxx trusts localhost/internal requests from proxx (no additional auth needed)
- WebSocket auth handled via proxx-generated short-lived tokens

## Deployment

### Compose stack
Voxx runs in the same compose project as proxx:

```yaml
services:
  proxx:
    # existing proxx service
    ports:
      - "8789:8789"
    networks:
      - gateway
    depends_on:
      - voxx

  voxx:
    build: ../../orgs/open-hax/voxx
    networks:
      - gateway
    volumes:
      - voxx-data:/data
    environment:
      - VOICE_GATEWAY_TTS_BACKEND_ORDER=elevenlabs,requesty,openai,melo,espeak
      - TTS_POSTPROCESS_ENABLED=1
      - TTS_POSTPROCESS_PROFILE=sports-commentator-v1
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              capabilities: [gpu]  # optional, for Melo TTS acceleration
```

### Host placement
- Voxx deploys to the same hosts as proxx (ussy, ussy2, ussy3, big.ussy)
- `VOXX_ENABLED` env var on proxx controls registration (default: true)
- GPU-capable hosts can enable Melo TTS acceleration
- Resource-constrained hosts can disable Voxx via compose profiles

### Data volumes
- Voxx: transcript storage, cached audio on host volume
- Proxx: SQL database (PostgreSQL) for config, credentials, and voice registry

## Affected files

### Proxx changes
- `src/routes/voice/index.ts` — new: Voxx proxy router
- `src/routes/api/v1/index.ts` — add voice control-plane route registration
- `src/lib/voice-registry.ts` — new: Voxx registry and health manager
- `src/lib/voice-proxy.ts` — new: reverse proxy logic for Voxx traffic (HTTP + WebSocket)
- `src/lib/voice-config.ts` — new: Voxx config persistence
- `docker-compose.yml` — add Voxx service
- `web/src/pages/Voice.tsx` — new: Voxx management UI page

### Voxx changes
- Add standardized `/api/config` GET/PUT endpoints for runtime settings
- Remove standalone auth (trust proxx instead)
- Bind to compose internal network only
- Add `/api/stats` endpoint for usage statistics
- Add `/api/backends` endpoint for backend status

## Phases

### Phase 1: Proxy + Registry
- Implement `VoxxRegistry` class in proxx
- Implement reverse proxy at `/api/v1/voice/*` to Voxx (HTTP endpoints)
- Add `/api/v1/voice/health` endpoint
- Update Voxx to remove standalone auth
- Add Voxx to proxx compose stack

### Phase 2: WebSocket Proxy
- Implement WebSocket proxy for realtime STT and TTS streams
- Handle auth token generation for WS connections
- Test bidirectional streaming through proxx

### Phase 3: Config Management
- Implement `/api/v1/voice/config` GET/PUT
- Add config persistence to proxx SQL store
- Build Voxx config UI in web console
- Add `/api/v1/voice/stats` and `/api/v1/voice/backends` endpoints

### Phase 4: Lifecycle Management
- Implement Voxx start/stop/restart via compose integration
- Add `/api/v1/voice/logs` endpoint
- Implement auto-restart policies
- Add Voxx status to web console dashboard

### Phase 5: Voice as MCP Tool
- Expose Voxx TTS as an MCP tool through the MCP gateway
- `mcp-voice` server that wraps Voxx endpoints as MCP tools
- Support voice output in proxx chat page

### Phase 6: Fleet-Wide Voice
- Register remote Voxx instances from host dashboard targets
- Support cross-host voice routing
- Implement Voxx deployment via compose push

## Verification
- `POST /api/v1/voice/speech` proxies to Voxx and returns audio
- `POST /api/v1/voice/transcriptions` proxies to Voxx and returns transcription
- `GET /api/v1/voice/health` returns Voxx status with backend info
- `GET /api/v1/voice/stats` returns TTS/STT usage statistics
- WebSocket realtime STT works through proxx proxy
- Unauthenticated requests to `/api/v1/voice/*` return 401
- Web console shows Voice page with Voxx status and backend health

## Definition of done
- Voxx is registered and proxied at `/api/v1/voice/*`
- Voxx no longer handles its own auth
- `/api/v1/voice/*` provides full Voxx management and API access
- WebSocket streaming works through proxx
- Web console has Voice management UI page
- Compose stack deploys proxx + Voxx together
- Fleet hosts can run Voxx with proxx as gateway

## Risks
- WebSocket proxy complexity for realtime streaming
- Voxx GPU requirements may limit host placement
- Audio payload size (large files) through proxy layer
- Backend fallback behavior when proxied through proxx
- Backward compatibility for existing direct connections to Voxx

## Related specs
- `proxx-mcp-gateway.md` — MCP server gateway integration behind proxx
- `proxx-openplanner-integration.md` — OpenPlanner data lake integration behind proxx
