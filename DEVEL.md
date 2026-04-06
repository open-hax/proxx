# Open Hax OpenAI Proxy

OpenAI-compatible proxy server with provider-scoped account rotation.

## Features

- `POST /v1/chat/completions` compatibility endpoint.
- Multi-provider routing through one OpenAI-compatible endpoint.
- Model-aware upstream routing for Claude models: `claude-*` can be sent to upstream `POST /v1/messages` and converted back into chat-completions format.
- Model-aware upstream routing: `gpt-*` models are sent to upstream `POST /v1/responses` and converted back into chat-completions format.
- Preserves reasoning traces when translating Responses/Messages payloads by mapping them to OpenAI-compatible `reasoning_content` in non-stream and synthetic stream responses.
- Maps OpenAI-style reasoning controls (`reasoning_effort` / `reasoning.effort`) into Claude `thinking` payloads and adds the interleaved-thinking beta header when enabled.
- Model-aware routing to OpenAI provider: models prefixed with `openai/` or `openai:` route to configured OpenAI endpoints.
- Model-aware routing to Ollama base API: models prefixed with `ollama/` or `ollama:` are sent to Ollama `POST /api/chat`.
- Built-in React/Vite console with a usage dashboard plus Chat, Credentials, and Tools/MCP pages.
- OpenAI OAuth browser + device flows based on OpenCode Codex plugin behavior (PKCE, state, callback exchange, account extraction).
- Chroma-backed semantic history search with lexical fallback for chat session recall.
- `GET /v1/models` and `GET /v1/models/:id` model listing.
- `GET /v1/models` merges static models with live Ollama/Ollama Cloud catalogs when configured.
- Auto-aliases tagged Ollama families to the largest variant (for example `qwen3.5` -> `qwen3.5:397b`).
- Provider-scoped account rotation when upstream returns rate limits (`429`, plus `403/503` with `retry-after`).
- Cross-provider fallback for shared models (for example `vivgrid` <-> `ollama-cloud`) when one provider's keys or upstream path fails.
- Optional `keys.json` seeds support both API-key and OAuth bearer accounts, with multiple accounts per provider.

## Setup

1. Prefer credentials in SQL via `DATABASE_URL` or provider env vars; use `keys.json` / `PROXY_KEYS_JSON` only as optional bootstrap seeds.
2. Optionally create `models.json` from `models.example.json` (preferences plus optional declared static model IDs; discovery is still canonical).
3. Set `PROXY_AUTH_TOKEN` (required by default).
4. Start the server.

```bash
pnpm --filter @workspace/open-hax-openai-proxy dev
```

Build and run production mode:

```bash
pnpm --filter @workspace/open-hax-openai-proxy build
pnpm --filter @workspace/open-hax-openai-proxy start
```

Run the web console in dev mode:

```bash
pnpm --filter @workspace/open-hax-openai-proxy web:dev
```

Build the web console:

```bash
pnpm --filter @workspace/open-hax-openai-proxy web:build
```

## Docker Compose

The container stack now mirrors the host-side shared-context pattern: one container, `pm2-runtime` as PID 1, and two managed processes inside it:

- `open-hax-openai-proxy` for the API on `8789`
- `open-hax-openai-proxy-web` for the bundled web companion on `5174`

From the workspace root, manage the proxy through the root stack registry:

```bash
pnpm docker:stack status open-hax-openai-proxy
pnpm docker:stack use-container open-hax-openai-proxy -- --build
pnpm docker:stack use-host open-hax-openai-proxy
pnpm docker:stack ps open-hax-openai-proxy
pnpm docker:stack logs open-hax-openai-proxy -- -f
```

From `services/proxx`, the local compose workflow is now:

```bash
cd /home/err/devel/services/proxx
docker compose -f docker-compose.yml -f docker-compose.factory-auth.override.yml up --build -d
docker compose ps
docker compose logs -f
```

Notes:

- upstream credentials are still required for proxying, but DB-backed runtimes should treat SQL and provider env vars as authoritative and use `keys.json` only as an optional seed.
- `data/` under `services/proxx` stays bind-mounted for request logs and session history.
- The compose stack now defaults `OLLAMA_BASE_URL` to `http://ollama:11434` when attached to the shared `ai-infra` network; `CHROMA_URL` still defaults to `host.docker.internal` unless you also containerize Chroma on a shared network.
- The web companion is exposed on `${PROXY_WEB_PORT:-5174}`.
- The checked-in host PM2 source now includes both the API and web companion in `ecosystems/services_open_hax_proxy.cljs`.
- The root stack registry now knows the related host PM2 apps, so plain container `up` is blocked while the host PM2 side is online.
- Use `use-container` and `use-host` to switch ownership cleanly between the host PM2 pair and the containerized pair.
- Omit `docker-compose.factory-auth.override.yml` when you do not need the Factory auth file mounts.

## Environment Variables

- `PROXY_HOST` (default: `127.0.0.1`)
- `PROXY_PORT` (default: `8789`; falls back to `PORT` for Render-style runtimes)
- `UPSTREAM_PROVIDER_ID` (default: `vivgrid`; provider id to target for routing; if you still use seed files, it also names the legacy default file provider)
- `UPSTREAM_FALLBACK_PROVIDER_IDS` (default: auto `ollama-cloud` when primary is `vivgrid`, or `vivgrid` when primary is `ollama-cloud`; comma-separated)
- `UPSTREAM_BASE_URL` (optional override; when unset or blank, the proxy derives it from `UPSTREAM_PROVIDER_ID` / `UPSTREAM_PROVIDER_BASE_URLS`)
- `UPSTREAM_PROVIDER_BASE_URLS` (optional mapping: `provider=url,provider=url`; defaults include `vivgrid=https://api.vivgrid.com`, `ollama-cloud=https://ollama.com`, `ob1=https://dashboard.openblocklabs.com/api`, `openrouter=https://openrouter.ai/api/v1`, and `requesty=https://router.requesty.ai/v1`)
- `OPENAI_PROVIDER_ID` (default: `openai`; provider id for OpenAI-routed accounts)
- `OPENAI_BASE_URL` (default: `https://chatgpt.com/backend-api`)
- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- `UPSTREAM_CHAT_COMPLETIONS_PATH` (default: `/v1/chat/completions`)
- `OPENAI_CHAT_COMPLETIONS_PATH` (default: `/v1/chat/completions`)
- `UPSTREAM_MESSAGES_PATH` (default: `/v1/messages`)
- `UPSTREAM_MESSAGES_MODEL_PREFIXES` (default: `claude-`; comma-separated prefixes)
- `UPSTREAM_MESSAGES_INTERLEAVED_THINKING_BETA` (default: `interleaved-thinking-2025-05-14`; set empty to disable auto `anthropic-beta` injection when thinking is enabled)
- `UPSTREAM_RESPONSES_PATH` (default: `/v1/responses`)
- `OPENAI_RESPONSES_PATH` (default: `/v1/responses`)
- `UPSTREAM_RESPONSES_MODEL_PREFIXES` (default: `gpt-`; comma-separated prefixes)
- `OPENAI_MODEL_PREFIXES` (default: `openai/,openai:`; comma-separated prefixes)
- `OLLAMA_CHAT_PATH` (default: `/api/chat`)
- `OLLAMA_MODEL_PREFIXES` (default: `ollama/,ollama:`; comma-separated prefixes)
- `PROXY_KEYS_FILE` (optional seed file path; DB-backed runtimes do not need it)
- `PROXY_MODELS_FILE` (default: `./models.json`, fallback: `VIVGRID_MODELS_FILE`)
- `PROXY_REQUEST_LOGS_FILE` (default: `./data/request-logs.jsonl`)
- `PROXY_KEY_RELOAD_MS` (default: `5000`, fallback: `VIVGRID_KEY_RELOAD_MS`)
- `PROXY_KEY_COOLDOWN_MS` (default: `30000`, fallback: `VIVGRID_KEY_COOLDOWN_MS`)
- `UPSTREAM_REQUEST_TIMEOUT_MS` (default: `180000`)
- `PROXY_AUTH_TOKEN` (required unless `PROXY_ALLOW_UNAUTHENTICATED=true`)
- `PROXY_ALLOW_UNAUTHENTICATED` (default: `false`; use `true` only for local debugging)
- `PROXY_KEYS_JSON` / `UPSTREAM_KEYS_JSON` (optional inline JSON seed payload; useful when you intentionally want to bootstrap from JSON rather than DB)
- `DISABLED_PROVIDER_IDS` (optional comma-separated provider ids to remove from routing without deleting stored credentials)
- `CHROMA_URL` (optional; default: `http://127.0.0.1:8000`)
- `CHROMA_COLLECTION` (optional; default: `open_hax_proxy_sessions`)
- `CHROMA_EMBED_MODEL` (optional; default: `nomic-embed-text:latest`; served from Ollama)

## Chroma + Ollama

Semantic session search now registers an Ollama embedding function with the Chroma JS client instead of relying on Chroma's default embedder.

- Start Chroma separately at `CHROMA_URL`.
- Ensure Ollama is running at `OLLAMA_BASE_URL`.
- Pull an embedding model such as `nomic-embed-text:latest`.

```bash
ollama pull nomic-embed-text:latest
```

The proxy will use Ollama's `/api/embed` endpoint when available, and fall back to `/api/embeddings` for older Ollama builds.

## Optional `keys.json` Seed Format

```json
{
  "providers": {
    "vivgrid": [
      "vivgrid-key-1",
      "vivgrid-key-2"
    ],
    "ollama-cloud": [
      "ollama-key-1",
      "ollama-key-2"
    ],
    "openai": {
      "auth": "oauth_bearer",
      "accounts": [
        "oauth-access-token-1",
        "oauth-access-token-2"
      ]
    }
  }
}
```

`id` fields are optional. When omitted, the proxy auto-generates stable internal UUID account IDs per token.

Backward compatibility is preserved for legacy single-provider formats:

- `{"keys": ["legacy-key-1", "legacy-key-2"]}`
- `["legacy-key-1", "legacy-key-2"]`

Those legacy formats map to `UPSTREAM_PROVIDER_ID`.

## `models.json` Preferences

`models.json` is preference metadata layered on top of provider discovery. It can also declare static model IDs for upstreams that do not expose a reliable catalog.

Supported uses:

- declare static model IDs with `models`
- prioritize discovered models with `preferred`
- disable models with `disabled`
- alias friendly names to real model IDs with `aliases`

Notes:

- Preferred models only reorder discovered models; they do not invent new upstream models.
- Aliases only apply when the target exists in the discovered or declared catalog.
- See `examples/blongs-definately-legit-model/` for a ready-made alias example targeting `http://185.255.121.4:8080`.

## OpenAI OAuth Routing Through Chat-Completions

Route requests to OpenAI by prefixing model names:

- `"model": "openai/gpt-5"`
- `"model": "openai:gpt-5"`

The prefix is stripped before upstream dispatch, and accounts are selected from the active credential store for `OPENAI_PROVIDER_ID` (SQL in DB-backed runtimes; optional `keys.json` only if you intentionally bootstrap from a seed file).

For migrated legacy OAuth accounts, the `openai` provider is treated as a ChatGPT Codex upstream, not the OpenAI Platform API. Those accounts require `chatgpt_account_id` metadata and are sent to `/codex/responses` by default.

## Ollama `num_ctx` Control Through OpenAI API

When you send requests through `POST /v1/chat/completions`, route to Ollama by prefixing the model:

- `"model": "ollama/llama3.2"`
- `"model": "ollama:llama3.2"`

Then set `num_ctx` through your OpenAI-style payload using either of these fields:

- `open_hax.ollama.num_ctx` (recommended)
- `num_ctx` (top-level alias)

Example:

```json
{
  "model": "ollama/llama3.2",
  "messages": [
    {
      "role": "user",
      "content": "Summarize this repository."
    }
  ],
  "open_hax": {
    "ollama": {
      "num_ctx": 32768
    }
  }
}
```

## Database Migrations

Schema changes use a version-tracked, idempotent migration system. **All migration SQL lives in one place** — the `ALL_MIGRATIONS` array in `src/lib/db/schema.ts`. The migration runner in `src/lib/db/sql-credential-store.ts` iterates this array on every startup; no SQL is hardcoded in the runner.

### How to add a migration

1. **Bump `SCHEMA_VERSION`** in `src/lib/db/schema.ts` to the new version number.
2. **Append to `ALL_MIGRATIONS`** with your SQL. Every statement must be idempotent:
   - `CREATE TABLE IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
3. **Run the schema migration tests**: `npx tsx --test src/tests/schema-migration.test.ts`
4. **Build**: `pnpm build`
5. **Apply to running instances**: run the `ALTER TABLE` / `CREATE TABLE` SQL directly against the database before restarting the container. The migration runner re-runs all entries idempotently on boot, but a fresh column must exist before the app queries it.

### Why this design

Historically, the runner hardcoded SQL inline while `ALL_MIGRATIONS` was maintained separately. This dual-entry caused drift — the runner would record a schema version without applying its migration. The refactor makes `ALL_MIGRATIONS` the single source of truth; the runner simply iterates it. Tests enforce that `SCHEMA_VERSION` matches the highest entry and that all SQL is idempotent.

## Side-by-Side Rollout

- Keep VivGrid proxy on `8787` and run this proxy on `8789` for parallel validation.
- Reuse the same keys/models files initially, then split once traffic migrates.
- Compare status codes, SSE behavior, and tool-call payloads before cutover.

## Example Request

```bash
curl --request POST \
  --url http://127.0.0.1:8789/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "gemini-3.1-pro-preview",
    "messages": [
      {
        "role": "user",
        "content": "Say hello in English, Chinese and Japanese."
      }
    ],
    "stream": true
  }'
```

## Peer Audit Curl Playbook

These assume you have sourced the root workspace `.envrc`, which exports:

```bash
export BIG_USSY_PROXY_AUTH_TOKEN=...
export BIG_USSY_FEDERATION_SPOKE_TOKEN=...
export TESTING_PROXX_AUTH_TOKEN="$BIG_USSY_PROXY_AUTH_TOKEN"
export STAGING_PROXX_AUTH_TOKEN=...
export PROD_PROXX_AUTH_TOKEN="$BIG_USSY_PROXY_AUTH_TOKEN"
export BIG_USSY_FEDERATION_BASE_URL="https://federation.big.ussy.promethean.rest"
export TESTING_PROXX_BASE_URL="https://testing.proxx.ussy.promethean.rest"
export STAGING_PROXX_BASE_URL="https://staging.proxx.ussy.promethean.rest"
export PROD_PROXX_BASE_URL="https://prod.proxx.ussy.promethean.rest"
export LOCAL_PROXX_BASE_URL="http://localhost:8789"
```

### Federation Hub

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/models" | jq -r '.data[].id'
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  "${BIG_USSY_FEDERATION_BASE_URL}/api/v1/federation/peers" | jq '.'
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/qwen3-coder:480b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:cephalon:fastest","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:27b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/gpt-oss:20b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${BIG_USSY_FEDERATION_BASE_URL}/v1/chat/completions" 2>&1
```

### Local

```bash
curl -s -H "Authorization: Bearer ${BIG_USSY_PROXY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${LOCAL_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

### Testing

```bash
curl -s -H "Authorization: Bearer ${TESTING_PROXX_AUTH_TOKEN}" \
  "${TESTING_PROXX_BASE_URL}/api/v1/federation/peers" | jq '.'
```

```bash
curl -s -H "Authorization: Bearer ${TESTING_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss:20b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${TESTING_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${TESTING_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:cephalon:fastest","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${TESTING_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

### Staging

```bash
curl -s -H "Authorization: Bearer ${STAGING_PROXX_AUTH_TOKEN}" \
  "${STAGING_PROXX_BASE_URL}/api/v1/federation/peers" | jq '.'
```

```bash
curl -s -H "Authorization: Bearer ${STAGING_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss:20b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${STAGING_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${STAGING_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:cephalon:fastest","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${STAGING_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

### Prod

```bash
curl -s -H "Authorization: Bearer ${PROD_PROXX_AUTH_TOKEN}" \
  "${PROD_PROXX_BASE_URL}/api/v1/federation/peers" | jq '.'
```

```bash
curl -s -H "Authorization: Bearer ${PROD_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss:20b","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${PROD_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${PROD_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:cephalon:fastest","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${PROD_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```

```bash
curl -s -H "Authorization: Bearer ${PROD_PROXX_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":100,"stream":false}' \
  "${PROD_PROXX_BASE_URL}/v1/chat/completions" 2>&1
```
