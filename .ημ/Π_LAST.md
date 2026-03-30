# Π Snapshot: ACO route scoring and quota cooldown persistence

- **Repo:** `open-hax/proxx`
- **Branch:** `feat/federation-sync-and-dynamic-ollama`
- **Pre-snapshot HEAD:** `2971d0e`
- **Previous tag:** `Π/20260330-081949-federation-sync-dynamic-ollama`
- **Intended Π tag:** `Π/20260330-205903-aco-route-quota-cooldowns`
- **Intended push branch:** `origin/fork-tax/20260330-205903-aco-route-quota-cooldowns`
- **Generated:** `2026-03-30T20:59:03Z`

## What this snapshot preserves

This Π handoff captures the provider-route ACO scoring slice, quota-driven cooldown persistence, and supporting docs/tests on top of the current `feat/federation-sync-and-dynamic-ollama` head.

Included work categories:
- pheromone-backed ACO ranking for dedicated Ollama routes across app/chat/images/responses plus fallback success/failure reinforcement in `src/lib/provider-route-aco.ts`, `src/lib/provider-route-pheromone-store.ts`, `src/lib/provider-strategy/fallback.ts`, and route wiring
- quota monitor integration with key-pool cooldown state, targeted OpenAI quota refreshes after rate limits, and stable cooldown identity across OAuth token refresh in `src/lib/quota-monitor.ts` and `src/lib/key-pool.ts`
- health/catalog/ops polish: fresh accounts start healthy, provider catalog fetches time out cleanly, Promethean web hosts are allow-listed in Vite, and `DEVEL.md` plus focused regression tests document the current behavior

## Dirty state before commit

### Modified
- `DEVEL.md`
- `src/app.ts`
- `src/lib/app-deps.ts`
- `src/lib/db/account-health-store.ts`
- `src/lib/key-pool.ts`
- `src/lib/provider-catalog.ts`
- `src/lib/provider-strategy/fallback.ts`
- `src/lib/quota-monitor.ts`
- `src/routes/chat.ts`
- `src/routes/images.ts`
- `src/routes/responses.ts`
- `src/tests/key-pool.test.ts`
- `src/tests/proxy.test.ts`
- `src/tests/quota-monitor.test.ts`
- `web/vite.config.ts`

### Untracked
- `src/lib/provider-route-aco.ts`
- `src/lib/provider-route-pheromone-store.ts`
- `src/tests/account-health-store.test.ts`
- `src/tests/provider-catalog.test.ts`
- `src/tests/provider-route-aco.test.ts`
- `src/tests/provider-route-pheromone-store.test.ts`

## Verification

- TypeScript build: `node node_modules/typescript/bin/tsc -p tsconfig.json` ✅
- Web build: `node node_modules/vite/bin/vite.js build --config web/vite.config.ts` ✅
- Focused unit coverage: `node --test --test-concurrency=1 dist/tests/account-health-store.test.js dist/tests/key-pool.test.js dist/tests/provider-catalog.test.js dist/tests/provider-route-aco.test.js dist/tests/provider-route-pheromone-store.test.js dist/tests/quota-monitor.test.js` ✅ (`23/23`)
- Focused proxy regression: `node --test --test-concurrency=1 --test-name-pattern='openai oauth accounts stay cooled until quota reset after a quota lookup refresh' dist/tests/proxy.test.js` ✅
- Broader file-level backend run: `node --test --test-concurrency=1 dist/tests/account-health-store.test.js dist/tests/key-pool.test.js dist/tests/provider-route-aco.test.js dist/tests/provider-route-pheromone-store.test.js dist/tests/quota-monitor.test.js dist/tests/proxy.test.js` ❌ (`158/177` passed; `19` failed in existing `proxy.test` coverage, including images/requesty, service-tier, ollama/native routes, and credentials summary assertions)
- Script wrapper note: `pnpm run build` and `pnpm run web:build` both failed locally with `spawn ELOOP`, so direct Node entrypoints were used for verification

## Operator note

This snapshot preserves the current ACO/quota-cooldown slice with focused green coverage while broader `proxy.test` coverage remains known-red outside the handoff boundary.
