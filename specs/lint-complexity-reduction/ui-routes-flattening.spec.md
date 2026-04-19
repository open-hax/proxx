# Spec: `ui-routes.ts` Monolith Deprecation and Surface Migration

## Problem Statement

`src/lib/ui-routes.ts` is still acting as the primary implementation surface for most UI and operator endpoints even though the repository already contains a partial route-module structure under `src/routes/**`.

Current state:

- `src/lib/ui-routes.ts` is **4145 lines** and still registers **47** HTTP handlers plus the federation bridge upgrade path.
- `src/routes/credentials/ui.ts` already exists and carries **14** credential-specific UI handlers.
- `src/routes/sessions/index.ts`, `settings/index.ts`, `federation/index.ts`, `hosts/index.ts`, `events/index.ts`, and `mcp/index.ts` are mostly placeholders.
- `web/src/lib/api.ts` and the current test suite still depend heavily on `/api/ui/*`.
- `src/routes/api/v1/index.ts` currently advertises `/api/v1/*` endpoints that are not yet broadly implemented.

The project needs a staged plan that:

1. deprecates `src/lib/ui-routes.ts` as the monolithic implementation owner,
2. preserves the currently shipped `/api/ui/*` contract while extraction is underway,
3. introduces a real successor surface for routes that should move to `/api/v1/*`, and
4. only then deprecates the legacy URL paths with explicit headers and a removal plan.

## Goals

1. Turn `src/lib/ui-routes.ts` into a thin composition/compatibility module.
2. Move domain handlers into `src/routes/<domain>/...` without changing behavior during extraction.
3. Ensure each domain's business logic exists in one place and can be mounted at more than one prefix.
4. Define an explicit, testable deprecation policy for old `/api/ui/*` paths.
5. Treat `/api/v1/*` as the canonical target namespace for migration from `/api/ui/*`.
6. Distinguish clearly between **planned** target endpoints and **implemented** target endpoints.

## Non-Goals

- Redesign response payloads or auth semantics as part of this migration.
- Rewrite the frontend at the same time as Phase 1 extraction.
- Refactor unrelated storage, pricing, or provider logic in the same workstream.
- Remove OAuth callback HTML flows or the federation WebSocket bridge unless they are being explicitly relocated.

## Key Constraints and Invariants

### Contract invariants

- No `/api/ui/*` route is marked deprecated until a working successor exists.
- Phase 1 extraction must preserve current response bodies, status codes, and auth checks.
- Existing frontend and test consumers must continue to pass unchanged during Phase 1.
- `/api/v1` discovery may list planned migration targets, but it must distinguish them from implemented endpoints.
- Legacy route deprecation starts only when the corresponding `/api/v1/*` endpoint is implemented, not merely planned.

### Code invariants

- Handler logic should be defined once per domain and reused by both legacy and successor route surfaces.
- Auth resolution and authorization checks should move toward shared prehandlers/utilities rather than repeated inline checks.
- Route extraction should be incremental by domain so each PR has a bounded blast radius.

## Current Route Ownership Snapshot

| Domain | Current implementation owner | Status |
|---|---|---|
| Credentials | `src/routes/credentials/ui.ts` | Extracted from monolith; use as template |
| Sessions | `src/lib/ui-routes.ts` | Still monolithic |
| Settings / Me / Tenants | `src/lib/ui-routes.ts` | Still monolithic |
| Request logs / dashboard / analytics | `src/lib/ui-routes.ts` | Still monolithic |
| Hosts | `src/lib/ui-routes.ts` | Still monolithic |
| Federation HTTP routes | `src/lib/ui-routes.ts` | Still monolithic |
| Federation WS bridge upgrade | `src/lib/ui-routes.ts` | Still monolithic and order-sensitive |
| Events | `src/lib/ui-routes.ts` | Still monolithic |
| UI assets / SPA entry routes | `src/lib/ui-routes.ts` | Still monolithic |

## Target Architecture

### Ownership model

`src/lib/ui-routes.ts` should become a composition root that only does work that truly spans domains or depends on registration order:

- temporary orchestration of route module registration,
- static UI asset resolution and SPA catch-all wiring,
- federation WebSocket bridge upgrade wiring until extracted cleanly,
- cross-domain helpers that have not yet been promoted into shared modules.

All domain-specific HTTP handlers should move to route modules.

### Proposed layout

```text
src/
├── lib/
│   └── ui-routes.ts                 # composition root / compat shim only
├── routes/
│   ├── shared/
│   │   ├── deprecation.ts          # deprecation headers + alias helpers
│   │   └── ui-auth.ts              # shared auth/prehandler helpers
│   ├── sessions/
│   │   ├── handlers.ts             # canonical session handlers
│   │   ├── ui.ts                   # /api/ui/sessions*
│   │   └── api-v1.ts               # /api/v1/sessions*
│   ├── settings/
│   │   ├── handlers.ts
│   │   ├── ui.ts
│   │   └── api-v1.ts
│   ├── hosts/
│   │   ├── handlers.ts
│   │   ├── ui.ts
│   │   └── api-v1.ts
│   ├── events/
│   │   ├── handlers.ts
│   │   ├── ui.ts
│   │   └── api-v1.ts
│   ├── federation/
│   │   ├── handlers.ts
│   │   ├── ui.ts
│   │   └── api-v1.ts
│   └── credentials/
│       └── ui.ts                   # existing extraction; align to shared helpers
```

### Registration model

Each domain should expose:

- a **canonical handler set**,
- a **legacy UI route registrar** for `/api/ui/*`, and
- eventually a **successor registrar** for `/api/v1/*`.

The legacy and successor registrars must call the same domain handlers.

## Deprecation Policy

Deprecation happens in two different layers and must not be conflated.

### Layer 1: Internal monolith deprecation

This starts immediately.

- `src/lib/ui-routes.ts` is deprecated as the place where domain logic lives.
- New UI/operator route logic should not be added directly to the monolith.
- New or migrated handlers must be placed under `src/routes/<domain>/...`.

This is a code ownership rule, not an HTTP behavior change.

### Layer 2: Legacy HTTP surface deprecation

This begins only after a domain has a verified successor surface.

For a given domain, `/api/ui/*` routes may be marked deprecated only when:

1. a `/api/v1/*` replacement exists,
2. both route surfaces are backed by the same handler logic,
3. tests cover both route surfaces, and
4. the frontend or other known first-party consumers have an upgrade path.

When deprecated, legacy routes should emit:

- `Deprecation: true`
- `Sunset: <HTTP-date>`
- `Link: </api/v1/...>; rel="successor-version"`
- `Warning: 299 - "Deprecated API; use /api/v1/..."`

Deprecation must be **per domain**, not all-or-nothing.

## Implementation Phases

### Phase 0: Baseline and migration-surface truthfulness cleanup

#### Deliverables

- Add this migration spec as the active plan for `ui-routes.ts` work.
- Audit the `/api/v1` root response so it models both:
  - implemented endpoints that are live now, and
  - planned migration targets that are the intended successors for `/api/ui/*`.
- Add explicit status metadata for `/api/v1` route discovery, e.g. `planned` vs `implemented`.
- Establish shared helper(s) for:
  - resolved UI auth access,
  - common unauthorized/forbidden responses where appropriate,
  - deprecation header emission.

#### Exit criteria

- The repo exposes `/api/v1/*` as the migration target namespace without pretending planned targets are already live.
- There is a clear shared place to put route deprecation mechanics.

### Phase 1: Contract-preserving extraction from the monolith

This phase keeps `/api/ui/*` as the only active HTTP surface for extracted domains.

#### Extraction order

1. **Sessions**
   - Low external coupling.
   - Good template for CRUD + search + fork flows.
2. **Settings / Me / Tenants**
   - Central auth reuse opportunity.
3. **Hosts**
   - Clear domain boundary.
4. **Events**
   - Clear domain boundary.
5. **Dashboard / request logs / analytics / tools**
   - Heavier shared helpers, but still HTTP-domain extractable.
6. **Federation HTTP routes**
   - Extract after shared auth and route scaffolding are stable.
7. **Static assets / SPA catch-all / WS bridge**
   - Move last because of order sensitivity.

#### Rules

- The extracted registrar owns the `/api/ui/*` path immediately.
- `src/lib/ui-routes.ts` may call that registrar, but may not keep the old inline handler.
- No deprecation headers yet.

#### Exit criteria

- Domain handlers for the extracted surface no longer live in `src/lib/ui-routes.ts`.
- Existing frontend and tests pass without path changes.

### Phase 2: Dual registration with real successors

For each extracted domain, add `/api/v1/*` routes backed by the same handlers.

#### Rules

- `/api/v1/*` routes used for legacy deprecation must be implemented, not just planned.
- The same permission checks must apply to both route surfaces.
- Discovery docs and the `/api/v1` index may expose both planned and implemented domains, but must label them accurately.

#### Exit criteria

- Each migrated domain has two route surfaces and one handler implementation.
- Tests cover both legacy and successor paths.

### Phase 3: HTTP deprecation of legacy `/api/ui/*` routes

Once a domain's `/api/v1/*` replacement is proven, make `/api/ui/*` a compatibility alias.

#### Rules

- Add deprecation headers to the legacy path.
- Add lightweight request logging/metrics for legacy path usage if practical.
- Migrate first-party frontend callers domain-by-domain.

#### Exit criteria

- First-party callers use `/api/v1/*` for the deprecated domain.
- Legacy path usage is visible and trending down.

### Phase 4: Sunset and removal

Remove `/api/ui/*` aliases only after:

- first-party frontend migration is complete,
- relevant tests no longer depend on the legacy path except explicit compatibility coverage,
- any required peer/operator clients have a published replacement path.

## Domain-by-Domain Work Plan

### Sessions (first exemplar)

#### Scope

- `GET /api/ui/sessions`
- `POST /api/ui/sessions`
- `GET /api/ui/sessions/:sessionId`
- `GET /api/ui/sessions/:sessionId/cache-key`
- `POST /api/ui/sessions/:sessionId/messages`
- `POST /api/ui/sessions/:sessionId/fork`
- `POST /api/ui/sessions/search`

#### Deliverables

- `src/routes/sessions/handlers.ts`
- `src/routes/sessions/ui.ts`
- updated `src/routes/sessions/index.ts`
- `src/lib/ui-routes.ts` reduced to calling the sessions registrar

#### Why first

- narrow domain boundary,
- existing frontend/test consumers,
- good template for future dual registration.

### Settings / Me / Tenants

#### Scope

- `/api/ui/settings`
- `/api/ui/me`
- `/api/ui/tenants`
- `/api/ui/tenants/:tenantId/...`

#### Special concern

Shared auth checks should be normalized here so later domains stop repeating inline `getResolvedAuth(...)` patterns.

### Analytics / Request Logs / Dashboard / Tools

#### Scope

- `/api/ui/request-logs`
- `/api/ui/dashboard/overview`
- `/api/ui/analytics/provider-model`
- `/api/ui/tools`
- `/api/ui/mcp-servers`

#### Special concern

Move domain registration first; deeper aggregation refactors can remain separate specs.

### Federation

#### Scope

- `/api/ui/federation/*`
- `/api/ui/federation/bridges*`
- `/api/ui/federation/bridge/ws`

#### Special concern

HTTP route extraction can happen before the WebSocket upgrade path. The upgrade handler may remain composed from `src/lib/ui-routes.ts` until the route and auth helpers are stable.

## Shared Utilities Required

### 1. UI auth helper

Create a shared helper/prehandler so route modules stop repeating request casts and inline auth guards.

Minimum responsibilities:

- read resolved auth from decorated Fastify request state,
- enforce presence where required,
- expose tenant/role helpers cleanly.

### 2. Deprecation helper

Create a shared helper for setting legacy route deprecation headers.

Example shape:

```typescript
export function markDeprecatedRoute(
  reply: { header: (name: string, value: string) => unknown },
  successorPath: string,
  sunsetUtc: string,
): void {
  reply.header("Deprecation", "true");
  reply.header("Sunset", sunsetUtc);
  reply.header("Link", `<${successorPath}>; rel="successor-version"`);
  reply.header("Warning", `299 - "Deprecated API; use ${successorPath}"`);
}
```

### 3. Prefix-aware registrar pattern

Avoid duplicating handler code by using either:

- separate `ui.ts` and `api-v1.ts` files that call shared handlers, or
- a single registrar that accepts a prefix and deprecation options.

## Verification Plan

### Per-phase verification

- Existing tests continue to pass for Phase 1 extractions.
- New tests cover any newly introduced `/api/v1/*` surface before legacy deprecation begins.
- For deprecated legacy routes, tests assert the presence of deprecation headers.
- Route inventory checks confirm handlers moved out of `src/lib/ui-routes.ts`.

### Repository truth checks

- `src/routes/api/v1/index.ts` distinguishes planned migration targets from implemented endpoints.
- `web/src/lib/api.ts` path usage is tracked during migration so caller upgrades are explicit.
- No domain handler exists simultaneously inline in the monolith and in a route module.

## Success Criteria

| Metric | Current | Phase 1 target | Phase 2 target | Final target |
|---|---:|---:|---:|---:|
| `src/lib/ui-routes.ts` file lines | 4145 | <2500 | <1200 | <400 |
| Handlers registered directly in `ui-routes.ts` | 47 | <25 | <10 | <4 |
| Domains extracted from monolith | 1 partial | 4 | 7 | all |
| `/api/v1` planned domains without explicit status labeling | several | 0 | 0 | 0 |
| Deprecated `/api/ui/*` routes without successor | unacceptable | 0 | 0 | 0 |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Behavior drift during extraction | Keep path and handler behavior constant in Phase 1; do not mix payload redesigns into extraction PRs. |
| Route order regressions | Leave static assets and WS upgrade logic in the monolith until route module ordering is explicit and tested. |
| Duplicate logic during dual registration | Require shared handler ownership before `/api/v1/*` is added. |
| Premature deprecation | Forbid deprecation headers until a working successor path exists and is tested. |
| `/api/v1` contract confusion | Keep `/api/v1` discovery truthful at every phase. |

## Immediate Next Slice

Execute the sessions exemplar first:

1. move `/api/ui/sessions*` handlers into `src/routes/sessions/ui.ts`,
2. add shared UI auth helper(s) needed by that route group,
3. reduce `src/lib/ui-routes.ts` to calling the sessions registrar,
4. keep the existing `/api/ui/sessions*` paths unchanged,
5. do **not** add deprecation headers yet.
