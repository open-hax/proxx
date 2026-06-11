---
uuid: "3e607555-3fce-40e0-b0cb-6bed9699a1f3"
title: "Stabilize ollama-lan embed runner: keep-alive resident + wedge watchdog"
status: incoming
priority: P1
labels: ["embeddings", "infra", "ollama", "reliability"]
created_at: "2026-06-08T00:44:38.000Z"
source: "kanban/embedding-routing-stability/stabilize-ollama-lan-embed-runner.md"
category: "infra"
parent: "22e8ce84-ab36-43c8-b0e8-91b3aceb598f"
---

# Stabilize ollama-lan embed runner

Part of epic `22e8ce84`.

## Problem
The LAN ollama box (`192.168.12.68:11434`) wedged its embedding runner: after keep-alive
expiry, ollama tried to unload `qwen3-embedding:0.6b`, the GPU-backed runner got stuck
(`size_vram: 0`, `expires_at` in the past, `ollama ps` showing `Stopping…` indefinitely),
and every subsequent `/api/embed` hung. Control-plane endpoints kept answering, masking it.

## Proposed changes
1. **Pin the embed model resident.** Set `OLLAMA_KEEP_ALIVE=-1` on the LAN box (or send
   `"keep_alive": -1` on embed requests). A 0.6B Q8 model is tiny; keeping it resident removes
   both the cold-load latency spikes and the unload-wedge trigger. **Highest-value change.**
2. **Protect VRAM.** If the box also serves chat models, tune `OLLAMA_MAX_LOADED_MODELS` /
   `OLLAMA_NUM_PARALLEL` so the embed model isn't evicted under pressure (eviction → reload →
   wedge risk).
3. **Wedge watchdog.** Add a watchdog that probes `/api/embed` with a tiny input on a short
   timeout (NOT `/api/tags` — the control plane lies) and restarts the ollama service if the
   probe hangs. See sibling task `618f8638` for the proxx-side health signal.
4. **GPU root-cause capture.** Next time it wedges, before restarting, capture
   `journalctl -u ollama`, the ollama server log, and `nvidia-smi` / `dmesg | grep -iE 'xid|nvrm|gpu'`
   to confirm thermal vs driver Xid vs OOM. "getting toasty" suggests thermal/driver instability.

## Acceptance criteria
- Embed model stays resident across idle periods (verify `ollama ps` keeps it loaded with
  non-zero VRAM, no `expires_at` in the past during normal operation).
- A forced keep-alive-expiry + reload cycle does not wedge (`/api/embed` returns < 2s after reload).
- Watchdog restarts ollama within a bounded window when `/api/embed` hangs.

## Notes
- Scope touches the LAN host config, not proxx code, but tracked here per the embedding epic.
