# Control-plane slice: settings + sessions v1

## Status
Draft

## Summary
Migrate the lowest-risk control-plane slice from `src/lib/ui-routes.ts` to canonical `/api/v1/*` endpoints backed by thin controllers and use-case services.

This spec covers tenant/session-context and stored chat session APIs first because they already have relatively clear use-case boundaries and minimal provider-specific orchestration.

## Source specs and notes
- `specs/drafts/control-plane-api-contract-v1.md`
- `specs/drafts/multitenancy-phase1-default-tenant-auth-schema.md`
- `docs/notes/experimental-design/2026.03.25.17.35.59.md`
- `docs/notes/experimental-design/2026.03.25.17.52.10.md`

## Scope

### Settings and tenant-context routes
- `GET /api/v1/settings`
- `POST /api/v1/settings`
- `GET /api/v1/me`
- `GET /api/v1/tenants`
- `POST /api/v1/tenants/:tenantId/select`
- `GET /api/v1/tenants/:tenantId/api-keys`
- `POST /api/v1/tenants/:tenantId/api-keys`
- `DELETE /api/v1/tenants/:tenantId/api-keys/:keyId`

### Session routes
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId/cache-key`
- `POST /api/v1/sessions/:sessionId/messages`
- `POST /api/v1/sessions/:sessionId/fork`
- `POST /api/v1/sessions/search`

### Legacy aliases retained during migration
- corresponding `/api/ui/*` routes remain as aliases

## Out of scope
- provider credential management
- provider OAuth/device/browser flows
- federation routes and bridge upgrades
- analytics/dashboard/request-log routes

## Current state
- settings, tenant-context, and session routes are registered inside `src/lib/ui-routes.ts`
- frontend calls these via `/api/ui/*` in `web/src/lib/api.ts`
- tenant-aware auth/session behavior already exists, but the route surface is not yet canonicalized under `/api/v1/*`

## Goals
1. Expose canonical `/api/v1/*` endpoints for settings and sessions.
2. Make controllers thin and service-driven.
3. Reuse existing stores and auth resolution logic rather than redesigning them.
4. Switch frontend callsites for this slice to `/api/v1/*`.
5. Keep `/api/ui/*` behavior identical through alias parity tests.

## Proposed service/use-case split

### Settings / tenant-context services
- `GetProxySettingsService`
- `SaveProxySettingsService`
- `GetCurrentActorService`
- `ListVisibleTenantsService`
- `SelectActiveTenantService`
- `ListTenantApiKeysService`
- `CreateTenantApiKeyService`
- `RevokeTenantApiKeyService`

### Session services
- `ListSessionsService`
- `CreateSessionService`
- `GetSessionService`
- `GetSessionCacheKeyService`
- `AddSessionMessageService`
- `ForkSessionService`
- `SearchSessionsService`

## Suggested affected files
- `src/app.ts`
- `src/routes/settings/index.ts`
- `src/routes/sessions/index.ts`
- `src/lib/ui-routes.ts`
- `src/lib/proxy-settings-store.ts`
- `src/lib/auth/*`
- `src/lib/session-store.ts`
- `src/lib/chroma-session-index.ts`
- `web/src/lib/api.ts`
- tests covering tenant/session flows

## Phases

### Phase A: settings + tenant-context controller/service split
- extract controllers and services for:
  - `/me`
  - `/tenants`
  - `/tenants/:tenantId/select`
  - `/settings`
- keep existing auth resolution and role checks
- expose canonical `/api/v1/*` endpoints alongside `/api/ui/*` aliases

### Phase B: tenant API key management under canonical control-plane routes
- move tenant API key list/create/revoke routes into the same slice
- keep authorization semantics from the existing implementation
- ensure request/response shapes remain stable for current UI consumers

### Phase C: session API extraction
- move session list/create/get/cache-key/message/fork/search into session controllers/services
- preserve `SessionStore` and `ChromaSessionIndex` behavior
- keep semantic index warmup and sync lifecycle out of controllers where possible

### Phase D: frontend migration + alias parity
- update `web/src/lib/api.ts` to use `/api/v1/*` for this slice
- retain `/api/ui/*` aliases
- add parity tests or shared test cases for old and new paths

## Verification
- existing session tests still pass
- tenant selection and API key management tests still pass
- frontend builds with `/api/v1/*` path changes
- parity tests confirm `/api/ui/*` and `/api/v1/*` return equivalent payloads/status codes

## Implementation status
- ✅ Canonical `/api/v1/settings`, `/api/v1/me`, `/api/v1/tenants`, `/api/v1/tenants/:tenantId/select`, and tenant API key management endpoints now reuse the modular settings route registration with a configurable prefix.
- ✅ `/api/ui/*` settings and tenant-context routes remain available via the same route modules using the legacy prefix.
- ✅ `/api/v1` migration summary now marks the `settings` slice as `implemented`.
- ✅ app-level auth and CORS handling now recognize `/api/v1/*` as UI-session-capable control-plane routes.
- ✅ Canonical `/api/v1/sessions`, `/api/v1/sessions/:sessionId`, `/api/v1/sessions/:sessionId/cache-key`, `/api/v1/sessions/:sessionId/messages`, `/api/v1/sessions/:sessionId/fork`, and `/api/v1/sessions/search` now reuse the extracted session route module with a configurable prefix.
- ✅ `/api/v1` migration summary now marks the `sessions` slice as `implemented`.
- ✅ session route tests now cover the canonical `/api/v1/sessions*` surface in addition to the legacy `/api/ui/sessions*` surface.
- ✅ `web/src/lib/api.ts` now uses `/api/v1/settings` and `/api/v1/sessions*` for the settings/session client surface.
- ✅ frontend validation passed via `pnpm web:build` after the client path switch.

## Risks
- session indexing/search lifecycle may still be too route-local if not moved carefully
- tenant/session auth context can regress if controller extraction changes request assumptions
- frontend may mix old and new paths unless switched slice by slice

## Definition of done
- this slice has canonical `/api/v1/*` endpoints
- frontend uses `/api/v1/*` for settings/session APIs
- `/api/ui/*` routes for this slice are aliases only
- no new settings/session route logic is added directly to `src/lib/ui-routes.ts`
