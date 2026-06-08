---
uuid: "fb515e6c-7e2f-49af-8aeb-932c38ec9b66"
title: "Revive llamacpp-stack as stable CPU embed primary"
status: incoming
priority: P2
labels: ["embeddings", "infra", "llamacpp", "reliability"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/revive-llamacpp-stack-cpu-embed.md"
category: "infra"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Revive llamacpp-stack as stable CPU embed primary

Part of epic `22e8ce84`.

## Problem
`llamacpp-embed` is the first provider in `:provider-order/embeddings` (intended primary), but
the container `llamacpp-stack-llamacpp-embed-1` has been **Exited (0) for 3 days**. proxx fast-fails
on it every request and falls through. The CPU llama.cpp embedding server is far more stable than
the GPU ollama path (no load/unload-unload-wedge dynamic, no VRAM contention) and makes a better
always-on primary, with the GPU LAN box as the fast path.

## Proposed changes
1. Bring up `services/llamacpp-stack` (`docker compose up -d`) and confirm it serves
   OpenAI-compatible `/v1/embeddings` for `qwen3-embedding:0.6b` at `http://llamacpp-embed:8081`.
2. Add it to compose autostart / restart policy so it survives reboots (it should not silently
   stay exited for days).
3. Decide the role split with ollama-lan once distribution lands (`dd2ab058`): CPU stack as the
   stable baseline, GPU box weighted for throughput.
4. Confirm the compact model path (`qwen3-embedding:4b`) — verify which backend actually serves
   the 4b compact embeds; the LAN box was only confirmed to hold the 0.6b model.

## Acceptance criteria
- `llamacpp-stack-llamacpp-embed-1` is `Up (healthy)` and survives a host reboot.
- A direct `POST http://llamacpp-embed:8081/v1/embeddings` returns vectors for 0.6b in < 1s.
- proxx routes embeddings to it without `fetch failed`.
