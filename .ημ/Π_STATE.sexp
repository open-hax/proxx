;; Π State Snapshot
;; Generated: 2026-03-30T20:59:03Z

(
  :repo "open-hax/proxx"
  :branch "feat/federation-sync-and-dynamic-ollama"
  :head-before "2971d0e"
  :previous-tag "Π/20260330-081949-federation-sync-dynamic-ollama"
  :intended-tag "Π/20260330-205903-aco-route-quota-cooldowns"
  :remote "origin/fork-tax/20260330-205903-aco-route-quota-cooldowns"
  :status-digest "64724b45814c311e"

  :work-description
  "Snapshot pheromone-backed provider-route ACO scoring, quota-driven cooldown persistence, and the supporting docs/tests on top of the current feat/federation-sync-and-dynamic-ollama head.

Includes:
- new provider-route ACO ranking and persistent pheromone state for dedicated Ollama routes
- quota monitor to key-pool cooldown wiring, targeted OpenAI quota refreshes after rate limits, and stable cooldown identity across OAuth token refresh
- fresh-account health baseline, provider catalog timeout hardening, Promethean Vite host allow-list updates, and focused regression coverage"

  :dirty-state (
    :modified [
      "DEVEL.md"
      "src/app.ts"
      "src/lib/app-deps.ts"
      "src/lib/db/account-health-store.ts"
      "src/lib/key-pool.ts"
      "src/lib/provider-catalog.ts"
      "src/lib/provider-strategy/fallback.ts"
      "src/lib/quota-monitor.ts"
      "src/routes/chat.ts"
      "src/routes/images.ts"
      "src/routes/responses.ts"
      "src/tests/key-pool.test.ts"
      "src/tests/proxy.test.ts"
      "src/tests/quota-monitor.test.ts"
      "web/vite.config.ts"
    ]
    :untracked [
      "src/lib/provider-route-aco.ts"
      "src/lib/provider-route-pheromone-store.ts"
      "src/tests/account-health-store.test.ts"
      "src/tests/provider-catalog.test.ts"
      "src/tests/provider-route-aco.test.ts"
      "src/tests/provider-route-pheromone-store.test.ts"
    ])

  :verification (
    :ts-build "pass (node node_modules/typescript/bin/tsc -p tsconfig.json)"
    :web-build "pass (node node_modules/vite/bin/vite.js build --config web/vite.config.ts)"
    :focused-unit-tests "pass (node --test --test-concurrency=1 dist/tests/account-health-store.test.js dist/tests/key-pool.test.js dist/tests/provider-catalog.test.js dist/tests/provider-route-aco.test.js dist/tests/provider-route-pheromone-store.test.js dist/tests/quota-monitor.test.js => 23/23)"
    :focused-proxy-test "pass (node --test --test-concurrency=1 --test-name-pattern='openai oauth accounts stay cooled until quota reset after a quota lookup refresh' dist/tests/proxy.test.js)"
    :broader-file-run "fail (node --test --test-concurrency=1 dist/tests/account-health-store.test.js dist/tests/key-pool.test.js dist/tests/provider-route-aco.test.js dist/tests/provider-route-pheromone-store.test.js dist/tests/quota-monitor.test.js dist/tests/proxy.test.js => 158/177 passed; 19 existing proxy.test failures across images/requesty, service-tier, ollama/native routes, and credentials summary assertions)"
    :pnpm-wrapper "fail (pnpm run build / pnpm run web:build => spawn ELOOP; verified via direct Node entrypoints instead)"))
