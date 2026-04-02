# Ad-hoc Policy/Strategy/Routing Code Audit

**Date:** 2026-04-02
**Scope:** `orgs/open-hax/proxx/src/` — policy, strategy, routing, and model selection code
**Reference:** `specs/drafts/control-plane-mvc-transition-roadmap.md`

---

## Executive Summary

The strategy engine (`provider-strategy/`), policy engine (`policy/`), and routing helpers (`provider-routing.ts`, `model-routing-helpers.ts`) are well-structured internally. The problems are **at the seams**:

1. Dead code and duplicate functions across module boundaries
2. Route handlers (`chat.ts`, `responses.ts`, `images.ts`) each manually orchestrate the full routing pipeline instead of delegating to a shared orchestrator
3. 55 ad-hoc type casts for `openHaxAuth` because Fastify lacks type augmentation
4. `app.ts` (1025 lines) has absorbed the composition root role but still contains inline business logic
5. Model family inference is implemented in 3 different places with different coverage

---

## Finding 1: Dead code — `model-selection-policies.ts` and `provider-route-policies.ts`

**Files:**
- `src/lib/model-selection-policies.ts` (62 lines) — **never imported**
- `src/lib/provider-route-policies.ts` (170 lines) — **never imported**

Both files export functions that were absorbed into `model-routing-helpers.ts` but the originals were never deleted.

`model-routing-helpers.ts` contains identical copies of:
- `resolvableConcreteModelIds` (also in dead `model-selection-policies.ts`)
- `resolvableConcreteModelIdsForProviders` (also in dead `model-selection-policies.ts`)
- `openAiProviderUsesCodexSurface` (also in dead `provider-route-policies.ts`)

**Impact:** Confusing for developers/agents. A future contributor might edit the dead file instead of the live one.

**Spec:** `dead-code-model-routing-cleanup.md`

---

## Finding 2: Model family inference scattered across 3 files

Three separate implementations determine "what family does this model belong to":

| File | Function/Constant | Coverage |
|------|-------------------|----------|
| `provider-route-policies.ts:34` | `inferModelFamily()` | openai, anthropic, google, zhipu, deepseek, moonshotai, qwen |
| `provider-strategy/fallback.ts:62` | `REQUESTY_MODEL_PREFIXES` array | openai, anthropic, google, deepseek, zhipu, moonshotai, qwen |
| `provider-routing.ts:32` | `looksLikeHostedOpenAiFamily()` | openai family only |

These are used for different purposes (routing preferences vs. Requesty provider mapping vs. Ollama exclusion) but the core question is the same: "what model family is this?" — and the answers can drift.

**Impact:** If a new model family is added (e.g. Mistral), three places must be updated. Already `inferModelFamily` and `REQUESTY_MODEL_PREFIXES` differ slightly in prefix matching logic.

**Spec:** `model-family-registry.md`

---

## Finding 3: Route handlers duplicate the full routing pipeline

`chat.ts` (498 lines), `responses.ts` (434 lines), and `images.ts` (210 lines) each manually orchestrate:

1. Tenant policy checks (`tenantModelAllowed`, `resolveExplicitTenantProviderId`)
2. Catalog fetch (`providerCatalogStore.getCatalog()`)
3. Disabled-model check
4. Model alias resolution
5. Auto-model candidate ranking
6. Provider route building (`buildProviderRoutesWithDynamicBaseUrls`)
7. Route filtering (`filterProviderRoutesByModelSupport`, `filterTenantProviderRoutes`)
8. Route ordering (`orderProviderRoutesByPolicy`)
9. Dynamic Ollama route discovery (`discoverDynamicOllamaRoutes`)
10. ACO ranking (`rankProviderRoutesWithAco`)
11. Execution (`executeProviderRoutingPlan`)
12. Federated fallback (`executeFederatedRequestFallback`)
13. Bridge fallback (`executeBridgeRequestFallback`)
14. Error summary handling (80+ lines of `sawRateLimit`/`sawUpstreamServerError`/...)

Steps 1-11 are nearly identical across all three files. Step 14 is a copy-paste block with minor wording differences.

**Impact:** Changes to routing policy (e.g. adding a new filter step) must be applied to 3 files. The error handling copy-paste already has subtle wording differences that could diverge further.

**Spec:** `data-plane-routing-orchestrator.md`

---

## Finding 4: Missing Fastify type augmentation — 55 ad-hoc casts

`app.ts:678` calls `app.decorateRequest("openHaxAuth", null)` but there is **no `declare module "fastify"` augmentation** to tell TypeScript about the property.

Result: 55 occurrences of this pattern across 19 files:
```typescript
(request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; ... } }).openHaxAuth
```

Worst offenders: `federation/ui.ts` (20), `chat.ts` (4), `responses.ts` (4), `images.ts` (3).

**Impact:** Type safety is defeated by the cast. If `ResolvedRequestAuth` changes shape, these 55 locations won't catch it at compile time. The repeated inline type literal is itself a drift risk.

**Spec:** `fastify-type-augmentation.md`

---

## Finding 5: `app.ts` absorbed composition root + inline business logic (1025 lines)

While `ui-routes.ts` was successfully reduced to 62 lines (a thin shim), `app.ts` grew to 1025 lines and now contains:

- **Lines 115-227:** Database initialization and seeding (inline)
- **Lines 287-457:** Token refresh handler logic (inline `refreshFactoryAccount`, `refreshExpiredOAuthAccount`, `ensureFreshAccounts`)
- **Lines 481-514:** HTML landing page template (inline)
- **Lines 680-794:** Auth hook with inline tenant quota enforcement, bridge auth resolution, session resolution
- **Lines 817-890:** ~20 inline OPTIONS handlers
- **Lines 953-959:** `/api/tags` handler inline

The roadmap Decision 7 says: "Construction of managers such as OAuth managers, session indexers, bridge relays, and long-lived stores should move out of route-registration god files and toward the composition root."

This has been partially done — the stores are constructed in `createApp` — but the **inline business logic** in hooks and handlers violates the thin-controller principle (Decision 6).

**Impact:** `createApp` is hard to test in isolation. Auth logic, quota logic, and refresh logic can't be unit-tested without spinning up the full Fastify app.

**Spec:** `app-composition-root-slimming.md`

---

## Finding 6: Duplicate catalog fetch within single request

`chat.ts` fetches the catalog twice per request:
- Line 81: `const catalogBundle = await deps.providerCatalogStore.getCatalog();` (alias resolution)
- Line 241: `const catalogBundle = await deps.providerCatalogStore.getCatalog();` (inside the model candidate loop, for disabled-model check and ACO ranking)

While `ProviderCatalogStore` caches internally, this is still a code smell: the intent is unclear (why fetch again?) and if caching behavior changes, this will cause unexpected DB/network load.

**Impact:** Low today due to internal caching, but a maintenance trap.

**Spec:** Covered by `data-plane-routing-orchestrator.md`

---

## Finding 7: Dynamic Ollama route discovery on every request

`chat.ts:195` and `responses.ts:185` call `discoverDynamicOllamaRoutes(deps.sqlCredentialStore, deps.sqlFederationStore, ...)` on individual requests when the model matches certain patterns. Meanwhile, `app.ts:579` already discovers dynamic routes at startup and caches them.

The per-request discovery is intentional (to pick up newly-joined federation peers), but the startup cache is never refreshed, creating a two-tier system with unclear semantics.

**Impact:** Potentially unnecessary DB queries on every Ollama-routed request. The startup cache is wasted work if per-request discovery always runs.

**Spec:** Covered by `data-plane-routing-orchestrator.md`

---

## Finding 8: `mcp/index.ts` is an empty scaffold

`routes/mcp/index.ts` registers zero routes:
```typescript
export async function registerMcpRoutes(_app: FastifyInstance, _deps: UiRouteDependencies): Promise<void> {}
```

Yet it's listed as `"implemented"` in `routes/api/v1/index.ts:62-67`. This is misleading — the endpoint descriptor says it's done but it's a no-op.

**Impact:** The OpenAPI discovery endpoint (`/api/v1`) lies about what's implemented.

**Spec:** `mcp-route-status-fix.md` (trivial, can be inlined)

---

## Finding 9: Dual dependency types — `AppDeps` vs `UiRouteDependencies`

Two overlapping dependency interfaces exist:
- `AppDeps` (in `app-deps.ts`, 74 lines) — used by data-plane routes (`chat.ts`, `responses.ts`, `images.ts`)
- `UiRouteDependencies` (in `routes/types.ts`, 47 lines) — used by control-plane routes

They share many fields but differ in others (e.g. `AppDeps` has `quotaMonitor`, `policyEngine`; `UiRouteDependencies` has `refreshOpenAiOauthAccounts`).

The route registration in `app.ts` constructs **both** separately (lines 894-908 and 919-932), duplicating the dependency wiring.

**Impact:** Adding a new shared dependency requires updating both interfaces and both construction sites. This already caused the `bridgeRelay` late-assignment hack at line 934-935.

**Spec:** `unify-deps-interface.md` (can be bundled into `app-composition-root-slimming.md`)

---

## Summary Table

| # | Finding | Severity | Est. SP |
|---|---------|----------|---------|
| 1 | Dead code: `model-selection-policies.ts`, `provider-route-policies.ts` | Low | 1 |
| 2 | Model family inference scattered across 3 files | Medium | 3 |
| 3 | Route handlers duplicate full routing pipeline | High | 5 |
| 4 | 55 ad-hoc `openHaxAuth` type casts (no Fastify augmentation) | Medium | 2 |
| 5 | `app.ts` 1025 lines — composition root + inline business logic | High | 5 |
| 6 | Duplicate catalog fetch within single request | Low | (covered by #3) |
| 7 | Two-tier dynamic Ollama discovery with unclear semantics | Low | (covered by #3) |
| 8 | MCP route listed as "implemented" but is a no-op | Low | 1 |
| 9 | Dual dependency types `AppDeps` vs `UiRouteDependencies` | Medium | (covered by #5) |

**Total estimated effort:** ~17 SP across 6 focused specs.
