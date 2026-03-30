# Control-plane slice: federation v1

## Status
Draft

## Summary
Migrate federation routes and bridge-related control-plane APIs from `src/lib/ui-routes.ts` into canonical `/api/v1/federation/*` routes with thin controllers and explicit services.

This slice is intentionally later than settings/sessions and credentials/auth because federation currently has the highest concentration of auth scoping, upgrade handling, and cross-store orchestration.

## Source specs and notes
- `specs/drafts/control-plane-api-contract-v1.md`
- `specs/drafts/federation-bridge-ws-v0.md`
- `specs/drafts/real-federation-peer-diff-and-at-did-auth.md`
- `specs/drafts/federated-tenant-provider-share-policies.md`
- `specs/drafts/shared-state-federation-v1.md`
- `docs/notes/experimental-design/2026.03.25.17.35.59.md`

## Scope

### Federation identity and policy routes
- `GET /api/v1/federation/self`
- `GET /api/v1/federation/peers`
- `POST /api/v1/federation/peers`
- `GET /api/v1/federation/tenant-provider-policies`
- `POST /api/v1/federation/tenant-provider-policies`

### Bridge session routes
- `GET /api/v1/federation/bridge/ws`
- `GET /api/v1/federation/bridges`
- `GET /api/v1/federation/bridges/:sessionId`

### Federation data movement routes
- `GET /api/v1/federation/diff-events`
- `GET /api/v1/federation/accounts`
- `GET /api/v1/federation/accounts/export`
- `POST /api/v1/federation/projected-accounts/import`
- `GET /api/v1/federation/projected-accounts/routed`
- `GET /api/v1/federation/projected-accounts/imported`
- `POST /api/v1/federation/projected-accounts/import-all`
- `GET /api/v1/federation/usage-export`
- `POST /api/v1/federation/usage-import`
- `POST /api/v1/federation/sync/pull`

### Legacy aliases retained during migration
- corresponding `/api/ui/federation/*` endpoints remain as aliases

## Out of scope
- data-plane request forwarding for `/v1/*`
- tenant auth/session routes unrelated to federation
- general analytics/dashboard endpoints unless required by federation parity tests

## Current state
- federation routes are all registered in `src/lib/ui-routes.ts`
- bridge upgrade auth and WebSocket handling are tightly coupled to route registration and relay construction
- route handlers currently combine authorization, store access, filtering/scoping, and response shaping inline

## Goals
1. Canonicalize federation routes under `/api/v1/federation/*`.
2. Separate controller logic from federation use-case orchestration.
3. Pull bridge relay lifecycle/creation toward the composition root.
4. Preserve tenant scoping and admin semantics.
5. Keep legacy `/api/ui/federation/*` endpoints as aliases during migration.

## Proposed service/use-case split

### Federation read services
- `GetFederationSelfService`
- `ListFederationPeersService`
- `ListTenantProviderPoliciesService`
- `ListBridgeSessionsService`
- `GetBridgeSessionService`
- `ListFederationAccountsService`
- `ExportFederationAccountsService`
- `ExportFederationUsageService`

### Federation write/sync services
- `CreateFederationPeerService`
- `UpsertTenantProviderPolicyService`
- `ImportProjectedAccountsService`
- `ImportAllProjectedAccountsService`
- `ImportFederationUsageService`
- `PullFederationSyncService`

### Bridge runtime services
- `AuthorizeBridgeUpgradeService`
- `AttachBridgeRelayRouteService`

## Suggested affected files
- `src/app.ts`
- `src/routes/federation/index.ts`
- `src/lib/ui-routes.ts`
- `src/lib/federation/bridge-relay.ts`
- `src/lib/federation/bridge-agent-autostart.ts`
- `src/lib/db/sql-federation-store.ts`
- `src/lib/db/sql-tenant-provider-policy-store.ts`
- federation tests

## Phases

### Phase A: federation read-only surface
- extract `self`, `peers` (GET), `tenant-provider-policies` (GET), `bridges` (GET) into controllers/services
- expose canonical `/api/v1/federation/*` endpoints
- preserve existing tenant/admin scoping behavior

### Phase B: federation mutations and policy writes
- extract peer creation and tenant-provider-policy upsert
- preserve validation and auth checks
- ensure write responses remain compatible for current UI consumers

### Phase C: accounts / diff / usage / sync operations
- extract account export/import/projected-account and usage sync routes into services
- reduce inline orchestration in handlers
- keep federation store operations explicit and testable

### Phase D: bridge relay lifecycle and upgrade handling
- move bridge relay creation and upgrade authorization out of the legacy route god file
- expose canonical `/api/v1/federation/bridge/ws`
- keep `/api/ui/federation/bridge/ws` as a compatibility alias until deprecation phase

## Verification
- existing federation bridge tests still pass
- tenant-scoped bridge visibility still holds
- parity tests cover `/api/ui/federation/*` and `/api/v1/federation/*`
- WebSocket upgrade authorization still rejects cross-origin/unauthorized requests correctly

## Implementation status
- ✅ Canonical `/api/v1/federation/self`, `/api/v1/federation/peers`, `/api/v1/federation/bridges`, `/api/v1/federation/bridges/:sessionId`, `/api/v1/federation/diff-events`, `/api/v1/federation/accounts`, `/api/v1/federation/accounts/export`, `/api/v1/federation/projected-accounts/import`, and `/api/v1/federation/tenant-provider-policies` now reuse the modular federation route layer with a configurable prefix.
- ✅ Canonical `/api/v1/federation/bridges*` now receive the live `bridgeRelay` through `registerApiV1Routes(...)` instead of running without bridge context.
- ✅ `web/src/lib/api.ts` now uses `/api/v1/federation/*` for self, peers, add-peer, accounts, and bridges.
- ✅ Canonical federation tests now cover `/api/v1/federation/self`, `/api/v1/federation/peers`, `/api/v1/federation/accounts`, and `/api/v1/federation/bridges`.
- ✅ Backend validation passed with targeted canonical federation tests plus typecheck and web build.
- 🚧 `syncFederationPeer()` in `web/src/lib/api.ts` still targets legacy `/api/ui/federation/sync/pull` because the canonical sync endpoint has not been moved into the modular federation registrar yet.
- 🚧 advanced federation routes still trapped in `src/lib/ui-routes.ts` include at least `projected-accounts/routed`, `projected-accounts/imported`, `projected-accounts/import-all`, `usage-export`, `usage-import`, and `sync/pull`.

## Risks
- bridge upgrade handling is sensitive to lifecycle and route order changes
- federation route handlers carry significant auth and scoping nuance
- migration can accidentally split canonical and legacy semantics if aliasing is not centralized

## Definition of done
- federation routes are canonically available under `/api/v1/federation/*`
- bridge upgrade/runtime wiring is no longer trapped inside `src/lib/ui-routes.ts`
- `/api/ui/federation/*` routes are aliases only
- federation controllers are thin and service-driven
