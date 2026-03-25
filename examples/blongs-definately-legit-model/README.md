# blongs-definately-legit-model

Ready-made example config for wiring `proxx` to a personal llama.cpp/OpenAI-compatible upstream at `http://185.255.121.4:8080`.

As of 2026-03-25, the endpoint answered:

- `GET /health` -> `200 {"status":"ok"}`
- `GET /v1/models` -> `model-f16.gguf`
- `POST /v1/chat/completions` -> `200` for `model-f16.gguf`

## Files

- `.env.example` sets the upstream provider id and base URL.
- `keys.example.json` uses a placeholder bearer token. The current llama.cpp host accepts requests even if it ignores Authorization, so any non-empty token works.
- `models.example.json` declares the upstream model id and aliases `blongs-definately-legit-model` -> `model-f16.gguf`.

## Use

Copy or merge these examples into your runtime files:

```bash
cp examples/blongs-definately-legit-model/keys.example.json keys.json
cp examples/blongs-definately-legit-model/models.example.json models.json
```

Then merge `examples/blongs-definately-legit-model/.env.example` into your `.env`.

Important:

- Set `UPSTREAM_BASE_URL=http://185.255.121.4:8080` exactly.
- Do **not** append `/v1`; `proxx` adds the API paths itself.
- If this upstream starts enforcing auth later, replace the placeholder key with the real credential.

Example request through `proxx`:

```bash
curl --request POST \
  --url http://127.0.0.1:8789/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer change-me-open-hax-proxy-token' \
  --data '{
    "model": "blongs-definately-legit-model",
    "messages": [
      {
        "role": "user",
        "content": "Say hello in one word."
      }
    ]
  }'
```