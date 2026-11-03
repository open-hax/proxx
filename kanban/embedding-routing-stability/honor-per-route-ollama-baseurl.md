---
uuid: "41ec2a04-3774-498a-b4b8-0e6402e0ca18"
title: "Honor per-route ollama baseUrl in embeddings dispatch"
status: incoming
priority: P1
labels: ["embeddings", "routing", "ollama", "bugfix"]
created_at: "2026-06-08T01:40:36.000Z"
source: "kanban/embedding-routing-stability/honor-per-route-ollama-baseurl.md"
category: "routing"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Honor per-route ollama baseUrl in embeddings dispatch

Part of epic `22e8ce84`. **Implemented** — see the accompanying PR.

## Problem
The embeddings route dispatched every ollama-family candidate to the global
`deps.config.ollamaBaseUrl` (the bare `ollama` provider's URL), ignoring the per-route
`baseUrl` declared in policy. So an `ollama-lan` candidate (`http://192.168.12.68:11434`)
was sent to the down local `ollama` instead, exhausting the route as
`embedding_upstream_unavailable` even though a healthy LAN backend existed. This is part of
why the embedding fallback chain never actually reached `ollama-lan` during the outage.

## Change
In `src/routes/embeddings.ts`, resolve a per-candidate base URL:

```ts
const candidateOllamaBaseUrl = (candidate.baseUrl ?? "").trim() || deps.config.ollamaBaseUrl;
```

and use it for both the context-fit preflight (`ensureNativeOllamaEmbedContextFits`) and the
actual `/api/embed` call, instead of the global `deps.config.ollamaBaseUrl`. The global value
remains the fallback only for the bare `ollama` provider.

## Acceptance criteria
- An `ollama-lan` embedding candidate is dispatched to its policy-declared base URL, not the
  global ollama URL.
- The bare `ollama` provider still uses `deps.config.ollamaBaseUrl` when no route baseUrl is set.

## Follow-ups (separate cards)
- `7c1fd7e6` per-attempt timeout + fast failover (a wedged route still stalls the request).
- `618f8638` inference-derived health so a dead route is scored down, not retried first.

## References
- `src/routes/embeddings.ts` (candidate loop)
- `src/lib/provider-routing.ts` (per-route baseUrl enrichment)
