# Proxx Specs: Breakdown, Priorities & Roadmap

**Generated:** 2026-04-02
**Total specs:** 58 (across `specs/drafts/` + `specs/lint-complexity-reduction/`)

---

## Status Summary

| Status | Count | SP Total |
|--------|-------|----------|
| Done | 20 | — |
| Partial (in progress) | 5 | ~12 remaining |
| Draft (not started) | 33 | ~148 |

**Estimated remaining work:** ~160 SP across 38 incomplete specs.

---

## P0 — Critical / Blocking (do first)

These block other specs or address live architectural debt that causes drift.

| # | Spec | SP | Status | Blocks |
|---|------|----|--------|--------|
| 1 | `control-plane-api-contract-v1.md` | 5 | Partial | All control-plane slices, legacy deprecation |
| 2 | `app-composition-root-slimming.md` | 3 remaining | Partial | app-modularization, all route extraction |
| 3 | `data-plane-routing-orchestrator.md` | 3 remaining | Partial | Route handler clarity, future routing changes |
| 4 | `legacy-api-ui-deprecation.md` | 5 | Partial | Cannot remove /api/ui/* until parity confirmed |
| 5 | `fallback-extraction.spec.md` (lint) | 8 | Draft | Highest-complexity file in the codebase (cognitive 399) |
| 6 | `app-modularization.spec.md` (lint) | 5 | Draft | Was 2337 lines, still ~976; gates all route work |

**P0 subtotal:** ~29 SP remaining

### Rationale
- **#1** (contract) is the prerequisite for every control-plane slice. It's partial because routes exist but the contract isn't formally locked with parity tests.
- **#2** (app.ts) still has inline token refresh logic (90 lines) and dual `AppDeps`/`UiRouteDependencies` wiring.
- **#3** (routing orchestrator) has `handleRoutingOutcome` done but `resolveModelRouting` (the catalog/alias pipeline) is not extracted.
- **#4** (legacy deprecation) can't land until every `/api/ui/*` endpoint has a confirmed `/api/v1/*` equivalent.
- **#5-6** are the lint complexity master plan's P0 targets. `fallback.ts` is 1058 lines with cognitive complexity ~399.

---

## P1 — High (architectural debt, near-term value)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 7 | `control-plane-slice-federation-v1.md` | 8 | Partial | Federation routes still delegate to `registerFederationUiRoutes` with prefix change only |
| 8 | `multitenancy-phase1-default-tenant-auth-schema.md` | 5 | Partial | Default tenant + API keys exist; tenant-scoped settings and membership management are incomplete |
| 9 | `federation-bridge-ws-v0.md` | 5 | Draft | Bridge relay exists in code but spec isn't formally closed |
| 10 | `real-federation-peer-diff-and-at-did-auth.md` | 5 | In progress | AT DID auth and diff streams partially implemented |
| 11 | `responses-stream-refactor.spec.md` (lint) | 5 | Draft | `processEvent` complexity 67 — needs event handler registry |
| 12 | `request-log-segmentation.spec.md` (lint) | 5 | Draft | 2533-line file, `buildUsageOverviewFromEntries` is 392 lines |
| 13 | `latency-health-routing-v1.md` | 5 | Draft | Per-account EWMA telemetry, perf-aware dashboard |
| 14 | `dynamic-provider-model-discovery.md` | 5 | Draft | Move from static models.json to live /v1/models discovery |
| 15 | `dashboard-usage-window-modes.md` | 3 | Draft | Daily/weekly/monthly toggle for usage counters |
| 16 | `credentials-refresh-and-gpt-concurrency.md` | 2 | In progress | Operator refresh controls + GPT routing tightening |
| 17 | `ui-preferences-localstorage.md` | 2 | Draft | localStorage persistence for dashboard preferences |

**P1 subtotal:** ~50 SP

### Rationale
- **#7-10** are the federation stack. They form a dependency chain and represent the most complex cross-cutting feature.
- **#11-12** are lint-complexity P1 targets that will unblock future refactoring.
- **#13-14** are routing improvements that directly affect production quality.
- **#15-17** are small UX/ops wins.

---

## P2 — Medium (important but not urgent)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 18 | `open-hax-openai-proxy-multitenancy-user-model.md` | 3 | Partial | Canonical spec, partially implemented |
| 19 | `multi-tenant-proxy-foundation.md` | 5 | Draft | Full tenant scoping across persistence |
| 20 | `proxy-federation.md` | 5 | Draft | Peer capability advertisement, loop prevention |
| 21 | `shared-state-federation-v1.md` | 3 | Draft | Multi-instance via shared DATABASE_URL |
| 22 | `cloud-deployment.md` | 5 | Draft | Render blueprints, stateless containers |
| 23 | `tenant-federation-cloud-roadmap.md` | 2 | Draft | Strategic sequencing document |
| 24 | `federated-tenant-provider-share-policies.md` | 5 | Draft | Share modes, trust tiers |
| 25 | `aco-systems-design.md` | 5 | Draft | Ant colony optimization for scanning + routing |
| 26 | `weekly-cost-water-validation.md` | 2 | Done | ✅ |
| 27 | `provider-model-analytics-page.md` | 2 | Done | ✅ |
| 28 | `dashboard-account-health-provider-filter.md` | 1 | Done | ✅ |
| 29 | `ussy-host-fleet-dashboard.md` | 2 | Done | ✅ |

**P2 subtotal:** ~40 SP (mostly federation/cloud/tenancy)

---

## P3 — Low (visionary, future integration)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 30 | `proxx-mcp-gateway.md` | 8 | Draft | Unified MCP gateway — large scope |
| 31 | `proxx-openplanner-integration.md` | 8 | Draft | Session data lake behind proxx |
| 32 | `proxx-graph-surface.md` | 5 | Draft | Myrmex graph crawler API |
| 33 | `proxx-voxx-integration.md` | 5 | Draft | Voice/audio service proxy |
| 34 | `openplanner-opencode-lite-and-mcp-tools.md` | 8 | Draft | Postgres-backed opencode-lite |
| 35 | `routed-image-analysis-tool.md` | 3 | Draft | Vision classifier + dispatch |
| 36 | `ussy3-staging-bootstrap-and-github-actions.md` | 3 | Draft | Staging deploy + CI gates |

**P3 subtotal:** ~40 SP

---

## Already Done (20 specs, 0 SP remaining)

These are closed and require no further work:

| Spec | Closed when |
|------|-------------|
| `dead-code-model-routing-cleanup.md` | This session |
| `fastify-type-augmentation.md` | This session |
| `model-family-registry.md` | This session |
| `mcp-route-status-fix.md` | This session |
| `claude-thinking-budget-mapping.md` | Prior session |
| `endpoint-agnostic-routing.md` | Prior session |
| `factory-4xx-diagnostics.md` | Prior session |
| `gpt-routing-excludes-ollama-cloud.md` | Prior session |
| `ollama-thinking-modelsdev-pricing.md` | Prior session |
| `dashboard-account-health-provider-filter.md` | Prior session |
| `weekly-cost-water-validation.md` | Prior session |
| `provider-model-analytics-page.md` | Prior session |
| `provider-thinking-capability-mapping.md` | Prior session |
| `provider-thinking-capability-report.md` | Prior session |
| `ussy-promethean-rest-deploy.md` | Prior session |
| `ussy-promethean-rest-ssl-and-pi.md` | Prior session |
| `ussy-host-fleet-dashboard.md` | Prior session |
| `zai-mistral-env-provider-validation.md` | Prior session |
| `zai-production-routing-hardening.md` | Prior session |
| `control-plane-slice-settings-sessions-v1.md` | Prior session |
| `control-plane-slice-credentials-auth-v1.md` | Prior session |
| `control-plane-slice-observability-v1.md` | Prior session |

---

## Recommended Roadmap

### Phase 1: Foundation (P0) — ~29 SP, 2-3 sessions

**Goal:** Lock the control-plane contract, slim app.ts to a real composition root, and bring the two worst-complexity files under control.

```
1. control-plane-api-contract-v1          (5 SP)  — lock contract, add parity tests
2. app-composition-root-slimming          (3 SP)  — extract token refresh, unify deps
3. data-plane-routing-orchestrator        (3 SP)  — extract resolveModelRouting
4. legacy-api-ui-deprecation              (5 SP)  — define removal gates
5. app-modularization (lint)              (5 SP)  — split createApp into modules
6. fallback-extraction (lint)             (8 SP)  — orchestrator + credential selector + error classifier
```

### Phase 2: Federation + Tenancy (P1) — ~30 SP, 3-4 sessions

**Goal:** Complete the federation bridge, land real peer diff sync, and finish multi-tenancy phase 1.

```
7. federation-bridge-ws-v0                (5 SP)  — relay bridge for NAT-bound clusters
8. real-federation-peer-diff-and-at-did-auth (5 SP) — AT DID auth, diff streams
9. control-plane-slice-federation-v1      (8 SP)  — extract federation routes
10. multitenancy-phase1                   (5 SP)  — tenant settings, membership mgmt
11. credentials-refresh-and-gpt-concurrency (2 SP) — operator controls
12. responses-stream-refactor (lint)      (5 SP)  — event handler registry
```

### Phase 3: Routing Quality (P1-P2) — ~18 SP, 2 sessions

**Goal:** Dynamic model discovery, latency-aware routing, and dashboard improvements.

```
13. dynamic-provider-model-discovery      (5 SP)  — live /v1/models over static JSON
14. latency-health-routing-v1             (5 SP)  — EWMA telemetry, perf dashboard
15. request-log-segmentation (lint)       (5 SP)  — split 2533-line store
16. dashboard-usage-window-modes          (3 SP)  — daily/weekly/monthly toggle
```

### Phase 4: Cloud + Multi-tenant Foundation (P2) — ~20 SP, 2-3 sessions

**Goal:** Cloud-ready deployment, full tenant scoping, federation policies.

```
17. cloud-deployment                      (5 SP)  — Render blueprints
18. multi-tenant-proxy-foundation         (5 SP)  — tenant_id on all tables
19. proxy-federation                      (5 SP)  — peer capability advertisement
20. federated-tenant-provider-share-policies (5 SP) — share modes + trust tiers
```

### Phase 5: Integrations (P3) — ~40 SP, 4+ sessions

**Goal:** MCP gateway, OpenPlanner, graph surface, voice — the platform vision.

```
21. proxx-mcp-gateway                     (8 SP)
22. proxx-openplanner-integration         (8 SP)
23. openplanner-opencode-lite-and-mcp-tools (8 SP)
24. proxx-graph-surface                   (5 SP)
25. proxx-voxx-integration                (5 SP)
26. routed-image-analysis-tool            (3 SP)
27. ussy3-staging-bootstrap               (3 SP)
```

---

## Dependency Graph (simplified)

```
control-plane-api-contract-v1
  ├── control-plane-slice-settings-sessions-v1    ✅ done
  ├── control-plane-slice-credentials-auth-v1     ✅ done
  ├── control-plane-slice-observability-v1        ✅ done
  ├── control-plane-slice-federation-v1           🔶 partial
  └── legacy-api-ui-deprecation                   🔶 partial
          └── (all slices at parity)

open-hax-openai-proxy-multitenancy-user-model
  ├── multitenancy-phase1                         🔶 partial
  ├── multi-tenant-proxy-foundation
  ├── proxy-federation
  ├── shared-state-federation-v1
  └── federated-tenant-provider-share-policies

MASTER.lint-complexity-reduction
  ├── fallback-extraction                        ⬜ (P0)
  ├── app-modularization                         ⬜ (P0)
  ├── responses-stream-refactor                  ⬜ (P1)
  ├── request-log-segmentation                   ⬜ (P1)
  ├── ui-routes-flattening                       ✅ (ui-routes.ts is 62 lines now)
  └── shared-utilities-split                     ⬜ (P2)

real-federation-peer-diff-and-at-did-auth
  └── federation-bridge-ws-v0
      └── federated-tenant-provider-share-policies
```
