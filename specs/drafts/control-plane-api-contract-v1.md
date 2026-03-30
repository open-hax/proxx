# Control-plane API contract v1

## Status
Draft

## Summary
Define the canonical HTTP contract and boundary rules for the `proxx` control-plane migration.

This spec must land before any major feature-slice extraction so that route movement does not create two drifting operator APIs.

## Source notes
- `docs/notes/experimental-design/2026.03.25.17.30.49.md`
- `docs/notes/experimental-design/2026.03.25.17.35.59.md`
- `docs/notes/experimental-design/2026.03.25.17.50.14.md`
- `docs/notes/experimental-design/2026.03.25.17.52.10.md`

## Related specs
- `specs/drafts/control-plane-mvc-transition-roadmap.md`
- `specs/lint-complexity-reduction/app-modularization.spec.md`
- `specs/lint-complexity-reduction/ui-routes-flattening.spec.md`

## Problem statement
Current operator APIs are effectively owned by `src/lib/ui-routes.ts`, while `/api/v1/*` exists only as partial scaffolding. Without a contract-first transition, the repository risks:

- duplicate route implementations
- drift between `/api/ui/*` and `/api/v1/*`
- fake MVC that only moves code into folders without changing ownership boundaries
- continued type/dependency coupling to the legacy monolith

## Goals
1. Define the canonical route surfaces.
2. Define which surfaces are stable, versioned, or legacy aliases.
3. Define controller/service/model/repository responsibilities.
4. Extract neutral shared route dependencies out of `src/lib/ui-routes.ts`.
5. Make `/api/v1/openapi.json` the canonical control-plane OpenAPI entry.

## Non-goals
- rewriting the `/v1/*` data-plane payload semantics
- redesigning provider strategy/policy internals
- removing `/api/ui/*` in this spec
- redesigning GitHub auth/session flows beyond route-placement and contract clarity

## Route surface contract

### Surface 1: data plane
Stable OpenAI-compatible client-facing proxy surface.

Prefix:
- `/v1/*`

Examples:
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `GET /v1/models`

Rules:
- no rename during this migration
- no control-plane concerns added unless strictly compatibility-related

### Surface 2: control plane
Canonical versioned operator/admin/UI JSON API.

Prefix:
- `/api/v1/*`

Examples:
- `/api/v1/settings`
- `/api/v1/me`
- `/api/v1/tenants`
- `/api/v1/sessions`
- `/api/v1/credentials`
- `/api/v1/federation/*`
- `/api/v1/dashboard/*`
- `/api/v1/analytics/*`

Rules:
- all newly migrated operator endpoints land here first
- OpenAPI for this surface is published under `/api/v1/openapi.json`
- frontend should progressively treat this as canonical

### Surface 3: legacy compatibility aliases
Temporary backward-compatible aliases for existing operator routes.

Prefix:
- `/api/ui/*`

Rules:
- alias only, not a second implementation
- should call the same controller/service path as `/api/v1/*`
- must be covered by parity tests during migration

### Surface 4: auth/session bootstrap
Human login/bootstrap/session routes.

Prefix:
- `/auth/*`

Rules:
- may remain unversioned in v1
- control-plane business APIs must not hide here

## Boundary rules

### Controllers
Controllers own:
- Fastify request/response wiring
- auth and tenant context acquisition
- DTO parsing/validation
- response shaping and status codes

Controllers do not own:
- multi-step business orchestration
- provider or SQL direct access except through services/repositories
- runtime object construction

### Services / use cases
Services own:
- business orchestration for one use case
- coordination across repositories and domain helpers
- stable interfaces to routing core / policy / federation facilities

### Models / repositories / infra
These own:
- domain entities and durable state access
- storage adapters
- external service/provider adapters

### Composition root
The composition root owns:
- creation of long-lived managers
- wiring dependencies into controllers/services
- bridge relay / OAuth manager / search index / store lifecycle

## Target file direction
This spec does not require an exact final directory tree, but new work should trend toward:

```text
src/
  app/
    http/
      routes/
      deps/
      openapi/
  features/
    settings/
    sessions/
    credentials/
    federation/
    observability/
  shared/
    infra/
    utils/
```

At minimum, neutral route dependency types must move out of `src/lib/ui-routes.ts`.

## Affected files
- `src/app.ts`
- `src/routes/api/v1/index.ts`
- `src/routes/index.ts`
- `src/routes/*`
- `src/lib/ui-routes.ts`
- `web/src/lib/api.ts`

## Phases

### Phase A: lock the path contract
- document the four route surfaces in code comments and spec/docs
- ensure `/api/v1/*` is named as canonical control-plane surface
- ensure `/api/ui/*` is treated as legacy alias surface in docs and new code comments

### Phase B: extract neutral route dependencies
- create a neutral dependency module for route registrars and controllers
- move `UiRouteDependencies`-like shared shapes out of `src/lib/ui-routes.ts`
- update new route modules to import from the neutral module, not from the legacy route file

### Phase C: route registrar contract
- define a stable registrar/controller pattern for control-plane route modules
- keep route registration order deterministic
- avoid `Promise.all(...)` registration where route-order semantics matter

### Phase D: OpenAPI ownership
- ensure `/api/v1/openapi.json` is the canonical control-plane OpenAPI path
- document whether it is whole-app or control-plane-filtered in v1
- prefer eventual filtering to control-plane routes only

## Verification
- search for imports from `../lib/ui-routes.js` or `../../lib/ui-routes.js` in new route modules
- verify `/api/v1/openapi.json` remains available
- ensure no migrated control-plane endpoint exists only under `/api/ui/*`
- verify registrar ordering is deterministic

## Implementation status
- ✅ Shared control-plane route dependency type extracted to `src/routes/types.ts`.
- ✅ Route modules under `src/routes/**` now import `UiRouteDependencies` from the neutral route type module instead of using `src/lib/ui-routes.ts` as their type anchor.
- ✅ `registerApiV1Routes(...)` now registers route modules sequentially instead of with `Promise.all(...)`, preserving deterministic route registration order.
- ✅ canonical `/api/v1/settings*` and `/api/v1/sessions*` routes now exist via prefix-aware modular route registration rather than living only under `/api/ui/*`.
- ✅ canonical `/api/v1/credentials*` routes now exist via prefix-aware modular route registration, with shared credential OAuth context reused across legacy and canonical registrations.
- ✅ canonical `/api/v1/request-logs`, `/api/v1/dashboard/overview`, `/api/v1/analytics/provider-model`, `/api/v1/tools`, and `/api/v1/mcp-servers` now exist through a dedicated observability route module.
- ✅ canonical `/api/v1/hosts/self` and `/api/v1/hosts/overview` now exist through the modular host route registrar.
- ✅ canonical `/api/v1/events*` routes now exist through the modular event route registrar.
- ✅ canonical `/api/v1/federation/*` now exists for the primary read/admin federation surface, though some advanced sync/import routes remain in the legacy monolith.
- 🚧 `/api/v1/openapi.json` still serves the app swagger bundle rather than a control-plane-filtered spec.

## Risks
- premature folderization without clear ownership rules
- dual implementations of legacy and canonical routes
- hidden runtime dependencies staying trapped inside `src/lib/ui-routes.ts`

## Definition of done
- path contract documented and used consistently
- neutral shared route deps exist outside `src/lib/ui-routes.ts`
- `/api/v1/*` is the explicit canonical target for new control-plane work
- future slice specs can migrate endpoints without redefining route semantics
