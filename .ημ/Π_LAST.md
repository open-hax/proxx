# Π Snapshot: federation sync and dynamic Ollama routing handoff

- **Repo:** `open-hax/proxx`
- **Branch:** `feat/federation-sync-and-dynamic-ollama`
- **Pre-snapshot HEAD:** `577ba0a`
- **Previous tag:** `Π/20260329-225737-federated-ollama-routing`
- **Intended Π tag:** `Π/20260330-081949-federation-sync-dynamic-ollama`
- **Generated:** `2026-03-30T08:19:49Z`

## What this snapshot preserves

This Π handoff captures the current federation control-plane expansion, dynamic/federated Ollama routing work, and credential/quota UI visibility fixes on top of the latest `origin/staging` base.

Included work categories:
- federation projected-account import-all, usage export/import, and sync-pull endpoints in `src/routes/federation/ui.ts`
- dynamic/federated Ollama route discovery, prioritization, and catalog-aware provider filtering across `src/app.ts`, `src/lib/dynamic-ollama-routes.ts`, `src/lib/model-routing-helpers.ts`, `src/routes/chat.ts`, and `src/routes/responses.ts`
- credential/quota UI filtering and canonical federation sync path updates across `src/routes/credentials/*`, `src/lib/openai-quota.ts`, and `web/src/lib/api.ts`

## Dirty state before commit

### Modified
- `deploy/docker-compose.big-ussy.hub-spokes.yml`
- `src/app.ts`
- `src/lib/dynamic-ollama-routes.ts`
- `src/lib/model-routing-helpers.ts`
- `src/lib/openai-quota.ts`
- `src/routes/chat.ts`
- `src/routes/credentials/get-credentials-ui.ts`
- `src/routes/credentials/openai-quota-ui.ts`
- `src/routes/federation/ui.ts`
- `src/routes/responses.ts`
- `src/tests/proxy.test.ts`
- `src/tests/tenant-provider-policy-routes.test.ts`
- `web/src/lib/api.ts`

### Untracked
- `src/routes/credentials/visible-accounts.ts`
- `src/tests/dynamic-ollama-routes.test.ts`
- `src/tests/model-routing-helpers.test.ts`

## Verification

- Typecheck: `pnpm run typecheck` ✅
- Web build: `pnpm run web:build` ✅
- Deploy compose validation: `docker compose --env-file deploy/targets/big-ussy-hub-spokes.env -f deploy/docker-compose.big-ussy.hub-spokes.yml config -q` ✅
- Targeted coverage: `node --test --test-concurrency=1 --test-name-pattern='prependDynamicOllamaRoutes|filterDedicatedOllamaRoutes|filterProviderRoutesByCatalogAvailability|federation sync pull imports projected descriptors from aggregated peer accounts|federation diff-events route stays wired after extraction and reports missing store cleanly' dist/tests/*.test.js` ✅
- Full suite: `pnpm test` ❌ (`421/444` passed, `23` failed across broader factory/request-log, federation bridge/relay, and native ollama coverage outside the targeted additions)

## Operator note

This snapshot preserves the current work on a clean `origin/staging` base even though the broader backend suite is still known-red outside the newly added targeted coverage.
