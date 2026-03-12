# Open Hax OpenAI Proxy

OpenAI-compatible proxy server with provider-scoped account rotation.

For workspace-specific development notes and the original internal guide, see `DEVEL.md`.

## Standalone Setup

```bash
git clone https://github.com/open-hax/proxx.git
cd proxx
pnpm install
cp .env.example .env
cp keys.example.json keys.json
cp models.example.json models.json
```

Required setup:

- Put real provider credentials in `keys.json`
- Set `PROXY_AUTH_TOKEN` in `.env` unless you are only doing local unauthenticated debugging
- Adjust `UPSTREAM_*`, `OPENAI_*`, `OLLAMA_*`, and optional `CHROMA_*` settings in `.env` for your environment

Env-backed providers:

- `OB1_API_KEY` automatically exposes an `ob1` provider route
- `OPENROUTER_API_KEY` automatically exposes an `openrouter` provider route
- `REQUESTY_API_TOKEN` automatically exposes a `requesty` provider route
- These providers default to OpenAI-compatible `/v1/chat/completions` routing
- You can target them by setting `UPSTREAM_PROVIDER_ID=ob1`, `UPSTREAM_PROVIDER_ID=openrouter`, or `UPSTREAM_PROVIDER_ID=requesty`, or by listing them in `UPSTREAM_FALLBACK_PROVIDER_IDS`

## Run

Start the API server:

```bash
pnpm dev
```

Build and run production mode:

```bash
pnpm build
pnpm start
```

Run tests:

```bash
pnpm test
```

## Web Console

Run the web UI in dev mode:

```bash
pnpm web:dev
```

Build the web UI:

```bash
pnpm web:build
```

Preview the built UI:

```bash
pnpm web:preview
```

## Docker Compose

From this repository root:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f
```

Notes:

- `keys.json` is required for startup
- `data/` stores request logs and session history
- The API defaults to `127.0.0.1:8789`
- The web companion is exposed on `${PROXY_WEB_PORT:-5174}`

## Example Request

```bash
curl --request POST \
  --url http://127.0.0.1:8789/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer change-me-open-hax-proxy-token' \
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
