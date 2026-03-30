# Control-plane MVC transition roadmap

## Status
Draft

## Summary
Transition `proxx` from a control plane concentrated in `src/lib/ui-routes.ts` toward a feature-sliced MVC-ish modular monolith with:

- stable OpenAI-compatible **data-plane** routes under `/v1/*`
- canonical versioned **control-plane** routes under `/api/v1/*`
- temporary legacy compatibility aliases under `/api/ui/*`
- thin controllers, explicit use-case services, and domain/repository boundaries behind them

This roadmap is intentionally incremental. It preserves current behavior while making room for versioned operator APIs, safer route extraction, and eventual removal of `ui-routes.ts` as the control-plane god file.

## Source notes
- `docs/notes/experimental-design/2026.03.25.17.30.49.md`
- `docs/notes/experimental-design/2026.03.25.17.35.59.md`
- `docs/notes/experimental-design/2026.03.25.17.50.14.md`
- `docs/notes/experimental-design/2026.03.25.17.52.10.md`
- `docs/notes/experimental-design/2026.03.25.06.29.19.md`

## Related existing specs
These are still useful and should be treated as supporting extraction specs rather than discarded work:

- `specs/lint-complexity-reduction/app-modularization.spec.md`
- `specs/lint-complexity-reduction/ui-routes-flattening.spec.md`
- `specs/lint-complexity-reduction/request-log-segmentation.spec.md`
- `specs/drafts/multitenancy-phase1-default-tenant-auth-schema.md`
- `specs/drafts/federation-bridge-ws-v0.md`
- `specs/drafts/provider-model-analytics-page.md`
- `specs/drafts/dashboard-usage-window-modes.md`
- `specs/drafts/weekly-cost-water-validation.md`
- `specs/drafts/ussy-host-fleet-dashboard.md`

## Current state
Observed repository shape:

- `src/app.ts` already exposes `/api/v1/openapi.json` and calls `registerApiV1Routes(...)`
- `src/routes/api/v1/index.ts` exists, but most route modules under `src/routes/*` are scaffolds/placeholders
- `src/lib/ui-routes.ts` still owns the real control-plane behavior and significant composition/runtime setup
- `web/src/lib/api.ts` still treats `/api/ui/*` as the canonical operator API
- tests and helper imports still reference `src/lib/ui-routes.ts` directly

This means the repo is already in a partial strangler state, but without a locked API contract or clear migration ordering.

## Architectural decisions

### Decision 1: keep `/v1/*` stable as the data plane
`/v1/*` is the OpenAI-compatible request surface and should remain stable during this transition.

Examples:
- `/v1/chat/completions`
- `/v1/responses`
- `/v1/embeddings`
- `/v1/models`

### Decision 2: make `/api/v1/*` the canonical control-plane API
All operator/admin/UI JSON APIs should converge on `/api/v1/*`.

Examples:
- `/api/v1/settings`
- `/api/v1/sessions`
- `/api/v1/credentials`
- `/api/v1/federation/*`
- `/api/v1/analytics/*`

### Decision 3: keep `/api/ui/*` as a temporary compatibility alias layer
`/api/ui/*` remains available during migration but stops being the canonical contract.

### Decision 4: preserve `/auth/*` as session-bootstrap/auth-entry surface
Human login/session bootstrapping can remain under `/auth/*` while control-plane business APIs move to `/api/v1/*`.

### Decision 5: migrate by feature slice, not by giant shared layer buckets
Preferred shape:

- `settings`
- `sessions`
- `credentials`
- `federation`
- `observability`

Each feature should own its controllers, services, DTO/view shapes, and repository adapters as needed.

### Decision 6: controllers stay thin
Controllers should:
- parse/validate HTTP input
- resolve auth/tenant context
- call one service/use-case
- map output into response/view format

Controllers should not:
- perform cross-provider orchestration
- create runtime managers ad hoc
- reach directly into DB or file stores except through dedicated services/repositories

### Decision 7: composition/runtime objects belong in the composition root
Construction of managers such as OAuth managers, session indexers, bridge relays, and long-lived stores should move out of route-registration god files and toward the composition root.

## Work packages

### 1. `control-plane-api-contract-v1.md`
Locks the route contract, versioning rules, controller/service boundaries, and neutral shared dependency types.

### 2. `control-plane-slice-settings-sessions-v1.md`
Migrates the lowest-risk control-plane slice first.

### 3. `control-plane-slice-credentials-auth-v1.md`
Migrates credential administration and provider-auth flows.

### 4. `control-plane-slice-federation-v1.md`
Migrates federation routes, bridge endpoints, and federation-specific admin APIs.

### 5. `control-plane-slice-observability-v1.md`
Migrates dashboard, analytics, request logs, hosts, tools, MCP, and events APIs.

### 6. `legacy-api-ui-deprecation.md`
Turns `/api/ui/*` into a formal compatibility layer and defines removal gates for `src/lib/ui-routes.ts`.

## Recommended execution order

1. contract / path rules
2. settings + sessions
3. credentials + provider auth
4. federation
5. observability
6. legacy `/api/ui/*` removal

## Dependency graph

- `control-plane-api-contract-v1.md` must land first
- all feature-slice specs depend on the contract spec
- `legacy-api-ui-deprecation.md` depends on all feature-slice specs reaching parity
- `control-plane-slice-observability-v1.md` should reuse `request-log-segmentation.spec.md`
- `control-plane-slice-federation-v1.md` should reuse `federation-bridge-ws-v0.md` and related federation drafts

## Non-goals
- redesigning the OpenAI-compatible `/v1/*` data-plane contract
- moving provider strategy/policy out of the routing core during this transition
- forcing all auth/login routes under `/api/v1/*`
- large schema redesign unrelated to control-plane route extraction
- microservice decomposition; this remains a modular monolith transition

## Verification gates

### Contract gates
- `/v1/*` behavior unchanged for existing proxy tests
- `/api/v1/*` documented as canonical control-plane surface
- `/api/ui/*` remains compatible until explicit removal phase

### Code-structure gates
- new route modules must not import dependency types from `src/lib/ui-routes.ts`
- new controllers must not instantiate long-lived managers inline
- feature slices should own their route/controller/service structure

### Compatibility gates
- for each migrated endpoint, add parity tests between `/api/ui/*` and `/api/v1/*`
- frontend switches to `/api/v1/*` slice by slice rather than all at once

## Definition of done
- `src/lib/ui-routes.ts` is reduced to a thin shim or removed entirely
- `web/src/lib/api.ts` uses `/api/v1/*` for all control-plane calls
- `src/routes/*` contain real feature-slice route registrars rather than placeholders
- control-plane controllers are thin and service-driven
- `/api/ui/*` is either formally deprecated or removed per the deprecation spec
