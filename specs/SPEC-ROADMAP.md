# Proxx Specs: Breakdown, Priorities & Roadmap

**Generated:** 2026-04-02
**Updated:** 2026-04-02 (post ui-routes.ts deletion)
**Total specs:** 57 files across 3 directories
**Obsolete specs:** 8 (marked as historical reference)

---

## Status Summary

| Status | Count | SP Total |
|--------|-------|----------|
| Done | 24 | — |
| Partial (in progress) | 3 | ~16 remaining |
| Draft (not started) | 22 | ~60 |
| Obsolete | 8 | — |

**Estimated remaining work:** ~76 SP across 25 active specs.

---

## P0 — Critical / Blocking (do first)

| # | Spec | SP | Status | Blocks |
|---|------|----|--------|--------|
| 1 | `routing-pipeline-extraction.md` | 3 remaining | Partial | Route handler clarity |
| 2 | `app-composition-slimming-v2.md` | 2 remaining | Partial | app.ts composition root |
| 3 | `control-plane-api-contract-v1.md` | 2 remaining | Partial | Contract parity tests |
| 4 | `reasoning-equivalence--responses-true-streaming.md` | 5 | Not started | Streaming equivalence |
| 5 | `reasoning-equivalence--messages-true-streaming.md` | 3 | Not started | Streaming equivalence |

**P0 subtotal:** ~15 SP remaining

### Rationale
- **#1** has `handleRoutingOutcome` done but `resolveModelRouting` (catalog/alias pipeline) not extracted
- **#2** has token-refresh-handlers.ts extracted but not wired into app.ts
- **#3** is mostly done — needs parity tests and OpenAPI filtering
- **#4-5** are correctness bugs — non-OpenAI Responses and Anthropic Messages don't stream reasoning

---

## P1 — High (architectural debt, near-term value)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 6 | `federation-slice-epic.md` | 8 → 3 sub-specs | Partial | Advanced federation routes not at /api/v1/* |
| 7 | `real-federation-peer-diff-and-at-did-auth.md` | 5 | In progress | Local 4-node validation done, staging pending |
| 8 | `multitenancy-phase1-default-tenant-auth-schema.md` | 2 remaining | Partial | Phase E partial |
| 9 | `federation-bridge-ws-v0.md` | 5 | Draft | Bridge relay for NAT-bound clusters |
| 10 | `responses-stream-refactor.spec.md` (lint) | 5 | OBSOLETE | Partially addressed by reasoning-equivalence |
| 11 | `request-log-segmentation.spec.md` (lint) | 5 | OBSOLETE | Superseded by observability slice |
| 12 | `latency-health-routing-v1.md` | 5 | Draft | EWMA telemetry, perf-aware dashboard |
| 13 | `dynamic-provider-model-discovery.md` | 5 | Draft | Live /v1/models over static JSON |
| 14 | `dashboard-usage-window-modes.md` | 3 | Draft | Daily/weekly/monthly toggle |
| 15 | `credentials-refresh-and-gpt-concurrency.md` | 2 | In progress | Operator refresh controls |
| 16 | `ui-preferences-localstorage.md` | 2 | Draft | localStorage persistence |

**P1 subtotal:** ~50 SP (minus 10 for obsolete)

---

## P2 — Medium (important but not urgent)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 17 | `open-hax-openai-proxy-multitenancy-user-model.md` | 3 | Partial | Canonical spec, partially implemented |
| 18 | `multi-tenant-proxy-foundation.md` | 5 | OBSOLETE | Absorbed by multitenancy-phase1 |
| 19 | `proxy-federation.md` | 5 | Draft | Peer capability advertisement, loop prevention |
| 20 | `shared-state-federation-v1.md` | 3 | Draft | Multi-instance via shared DATABASE_URL |
| 21 | `cloud-deployment.md` | 5 | Draft | Render blueprints, stateless containers |
| 22 | `tenant-federation-cloud-roadmap.md` | 2 | Draft | Strategic sequencing document |
| 23 | `federated-tenant-provider-share-policies.md` | 5 | Draft | Share modes, trust tiers |
| 24 | `aco-systems-design.md` | 5 | Draft | Ant colony optimization for scanning + routing |
| 25 | `weekly-cost-water-validation.md` | 2 | Done | ✅ |
| 26 | `provider-model-analytics-page.md` | 2 | Done | ✅ |
| 27 | `dashboard-account-health-provider-filter.md` | 1 | Done | ✅ |
| 28 | `ussy-host-fleet-dashboard.md` | 2 | Done | ✅ |

**P2 subtotal:** ~40 SP (minus 5 for obsolete)

---

## P3 — Low (visionary, future integration)

| # | Spec | SP | Status | Notes |
|---|------|----|--------|-------|
| 29 | `proxx-mcp-gateway.md` | 8 → 3 sub-specs | Draft | See mcp-gateway-epic.md |
| 30 | `proxx-openplanner-integration.md` | 8 → 3 sub-specs | Draft | See openplanner-integration-epic.md |
| 31 | `proxx-graph-surface.md` | 5 | Draft | Myrmex graph crawler API |
| 32 | `proxx-voxx-integration.md` | 5 | Draft | Voice/audio service proxy |
| 33 | `openplanner-opencode-lite-and-mcp-tools.md` | 8 → 3 sub-specs | Draft | See opencode-lite-mcp-epic.md |
| 34 | `routed-image-analysis-tool.md` | 3 | Draft | Vision classifier + dispatch |
| 35 | `ussy3-staging-bootstrap-and-github-actions.md` | 3 | Draft | Staging deploy + CI gates |

**P3 subtotal:** ~40 SP

---

## Already Done (24 specs, 0 SP remaining)

| Spec | Closed when |
|------|-------------|
| `mcp-route-status-fix.md` | This session |
| `dead-code-model-routing-cleanup.md` | This session |
| `fastify-type-augmentation.md` | This session |
| `model-family-registry.md` | This session |
| `routing-pipeline-extraction.md` (Step 1) | This session |
| `app-composition-slimming-v2.md` (Step 4) | This session |
| `catalog-alias-resolver.ts` | This session |
| `token-refresh-handlers.ts` | This session |
| `reasoning-equivalence--stream-payload-check.md` | This session |
| `reasoning-equivalence--field-name-normalization.md` | This session (audit: already consistent) |
| `reasoning-equivalence--request-effort-mapping.md` | This session |
| `fallback-extraction-epic.md` (all 4 sub-specs) | This session |
| `contract-deprecation--frontend-migration.md` | Prior session |
| `contract-deprecation--deprecation-headers.md` | Prior session |
| `contract-deprecation--openapi-cleanup.md` | This session |
| `claude-thinking-budget-mapping.md` | Prior session |
| `endpoint-agnostic-routing.md` | Prior session |
| `factory-4xx-diagnostics.md` | Prior session |
| `gpt-routing-excludes-ollama-cloud.md` | Prior session |
| `ollama-thinking-modelsdev-pricing.md` | Prior session |
| `provider-thinking-capability-mapping.md` | Prior session |
| `provider-thinking-capability-report.md` | Prior session |
| `ussy-promethean-rest-deploy.md` | Prior session |
| `ussy-promethean-rest-ssl-and-pi.md` | Prior session |
| `zai-mistral-env-provider-validation.md` | Prior session |
| `zai-production-routing-hardening.md` | Prior session |

---

## Obsolete Specs (8 files, marked as historical reference)

| File | Superseded by |
|------|---------------|
| `app-composition-root-slimming.md` | `app-composition-slimming-v2.md` |
| `data-plane-routing-orchestrator.md` | `routing-pipeline-extraction.md` |
| `lint-complexity-reduction/fallback-extraction.spec.md` | `epics/fallback-extraction-epic.md` |
| `lint-complexity-reduction/app-modularization.spec.md` | `control-plane-mvc-transition-roadmap.md` |
| `lint-complexity-reduction/ui-routes-flattening.spec.md` | `contract-deprecation-epic.md` |
| `lint-complexity-reduction/responses-stream-refactor.spec.md` | `reasoning-equivalence-epic.md` |
| `lint-complexity-reduction/shared-utilities-split.spec.md` | `fallback-extraction-epic.md` |
| `lint-complexity-reduction/request-log-segmentation.spec.md` | `control-plane-slice-observability-v1.md` |

---

## Epics

### Epic: `contract-deprecation` (8 SP) ✅ DONE
| Sub-spec | SP | Status |
|----------|----|--------|
| frontend-migration | 3 | ✅ |
| deprecation-headers | 3 | ✅ |
| openapi-cleanup | 2 | ✅ |

### Epic: `fallback-extraction` (8 SP) ✅ DONE
| Sub-spec | SP | Status |
|----------|----|--------|
| error-classifier | 2 | ✅ |
| credential-selector | 2 | ✅ |
| response-handler-orchestrator | 3 | ✅ |
| early-return-strategy | 3 | ✅ |

### Epic: `reasoning-equivalence` (13 SP) — 3/5 done
| Sub-spec | SP | Status |
|----------|----|--------|
| stream-payload-check | 2 | ✅ |
| field-name-normalization | 2 | ✅ (already consistent) |
| request-effort-mapping | 1 | ✅ |
| responses-true-streaming | 5 | ⬜ Not started |
| messages-true-streaming | 3 | ⬜ Not started |

### Epic: `federation-slice` (8 SP) — Partial
| Sub-spec | SP | Status |
|----------|----|--------|
| advanced-routes | 3 | ⬜ Not started |
| bridge-relay-lifecycle | 3 | ⬜ Not started |
| parity-tests | 2 | ⬜ Not started |

### Epic: `mcp-gateway` (8 SP) — Not started
| Sub-spec | SP | Status |
|----------|----|--------|
| registry-proxy | 5 | ⬜ |
| control-plane-config | 3 | ⬜ |
| lifecycle-tools | 3 | ⬜ |

### Epic: `openplanner-integration` (8 SP) — Not started
| Sub-spec | SP | Status |
|----------|----|--------|
| proxy-registry | 5 | ⬜ |
| config-lifecycle | 3 | ⬜ |
| session-search-migration | 3 | ⬜ |

### Epic: `opencode-lite-mcp` (8 SP) — Not started
| Sub-spec | SP | Status |
|----------|----|--------|
| opencode-lite | 5 | ⬜ |
| tool-discovery | 3 | ⬜ |
| agent-loop | 3 | ⬜ |

---

## Recommended Roadmap

### Phase 1: Remaining P0 (~15 SP) — 1-2 sessions
1. `routing-pipeline-extraction` (3 SP) — extract resolveModelRouting
2. `app-composition-slimming-v2` (2 SP) — wire token-refresh-handlers
3. `reasoning-equivalence--responses-true-streaming` (5 SP)
4. `reasoning-equivalence--messages-true-streaming` (3 SP)
5. `control-plane-api-contract-v1` remaining (2 SP) — parity tests

### Phase 2: Federation + Tenancy (~15 SP) — 2 sessions
6. `federation-slice-epic` (8 SP) — advanced routes + bridge relay + parity
7. `real-federation-peer-diff-and-at-did-auth` (5 SP)
8. `multitenancy-phase1` remaining (2 SP)

### Phase 3: Routing Quality (~13 SP) — 1-2 sessions
9. `dynamic-provider-model-discovery` (5 SP)
10. `latency-health-routing-v1` (5 SP)
11. `dashboard-usage-window-modes` (3 SP)

### Phase 4: Cloud + Federation Policies (~18 SP) — 2 sessions
12. `cloud-deployment` (5 SP)
13. `proxy-federation` (5 SP)
14. `federated-tenant-provider-share-policies` (5 SP)
15. `shared-state-federation-v1` (3 SP)

### Phase 5: Integrations (~40 SP) — 4+ sessions
16. `proxx-mcp-gateway` (8 SP)
17. `proxx-openplanner-integration` (8 SP)
18. `openplanner-opencode-lite-and-mcp-tools` (8 SP)
19. `proxx-graph-surface` (5 SP)
20. `proxx-voxx-integration` (5 SP)
21. `routed-image-analysis-tool` (3 SP)
22. `ussy3-staging-bootstrap` (3 SP)
