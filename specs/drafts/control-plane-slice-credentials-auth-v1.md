# Control-plane slice: credentials + provider auth v1

## Status
Draft

## Summary
Migrate credential administration and provider-auth flows out of `src/lib/ui-routes.ts` into canonical `/api/v1/*` control-plane routes with thin controllers and explicit services.

This spec covers provider credential management, quota/probe APIs, and provider OAuth browser/device flows. Human GitHub login routes under `/auth/*` remain out of scope except where they intersect with dependency wiring.

## Source specs and notes
- `specs/drafts/control-plane-api-contract-v1.md`
- `specs/drafts/credentials-refresh-and-gpt-concurrency.md`
- `docs/notes/experimental-design/2026.03.25.17.35.59.md`
- `docs/notes/experimental-design/2026.03.25.17.52.10.md`

## Scope

### Credential management routes
- `GET /api/v1/credentials`
- `POST /api/v1/credentials/api-key`
- `DELETE /api/v1/credentials/account`

### Provider diagnostics routes
- `GET /api/v1/credentials/openai/quota`
- `POST /api/v1/credentials/openai/probe`
- `POST /api/v1/credentials/openai/oauth/refresh`

### Provider OAuth routes
- `POST /api/v1/credentials/openai/oauth/browser/start`
- `GET /api/v1/credentials/openai/oauth/browser/callback`
- `POST /api/v1/credentials/openai/oauth/device/start`
- `POST /api/v1/credentials/openai/oauth/device/poll`
- `POST /api/v1/credentials/factory/oauth/browser/start`
- `POST /api/v1/credentials/factory/oauth/device/start`
- `POST /api/v1/credentials/factory/oauth/device/poll`

### Legacy aliases retained during migration
- corresponding `/api/ui/*` credential/auth routes remain as aliases

## Out of scope
- GitHub `/auth/*` login bootstrap surface
- `/v1/*` request auth path
- federation-specific credential sharing APIs

## Current state
- these endpoints are registered inside `src/lib/ui-routes.ts`
- the legacy file also constructs `OpenAiOAuthManager`, `FactoryOAuthManager`, pending browser reauth maps, and related runtime helpers
- frontend currently uses `/api/ui/*` for credential administration

## Goals
1. Create canonical `/api/v1/*` routes for credentials and provider auth.
2. Move provider-auth runtime setup out of the route god file and toward the composition root.
3. Preserve response shapes so the frontend can switch with minimal churn.
4. Keep device/browser callback behavior backward-compatible during migration.

## Proposed service/use-case split

### Credential services
- `ListCredentialsService`
- `AddApiKeyCredentialService`
- `RemoveCredentialService`
- `RefreshOpenAiOauthAccountsService`

### Diagnostics services
- `GetOpenAiQuotaService`
- `ProbeOpenAiCredentialAccountService`

### Provider auth services
- `StartOpenAiBrowserOauthService`
- `HandleOpenAiBrowserOauthCallbackService`
- `StartOpenAiDeviceOauthService`
- `PollOpenAiDeviceOauthService`
- `StartFactoryBrowserOauthService`
- `StartFactoryDeviceOauthService`
- `PollFactoryDeviceOauthService`

## Suggested affected files
- `src/app.ts`
- `src/routes/credentials/index.ts`
- `src/lib/ui-routes.ts`
- `src/lib/openai-oauth.ts`
- `src/lib/factory-oauth.ts`
- `src/lib/openai-quota.ts`
- `src/lib/credential-store.ts`
- `src/lib/db/sql-credential-store.ts`
- `web/src/lib/api.ts`
- credential/auth tests

## Phases

### Phase A: credential list/mutation APIs
- extract list/add/remove credential logic into controllers/services
- expose canonical `/api/v1/credentials*` endpoints
- preserve current query/body shapes used by `web/src/lib/api.ts`

### Phase B: quota/probe diagnostics
- extract OpenAI quota and probe routes into dedicated services
- preserve current response shapes for dashboard/credential UI use
- avoid route-local aggregation or formatting logic where possible

### Phase C: OpenAI and Factory OAuth flows
- move browser/device start + poll + callback handlers behind controller/service boundaries
- keep callback compatibility for legacy paths while canonicalizing to `/api/v1/*`
- move OAuth manager creation toward the composition root

### Phase D: frontend switch + route aliasing
- update `web/src/lib/api.ts` to prefer `/api/v1/*` for credential/auth calls
- retain `/api/ui/*` aliases
- add parity tests across old and new paths

## Verification
- credential UI flows still work end-to-end
- quota/probe tests still pass
- browser/device OAuth tests still pass
- route aliases return equivalent status codes and payloads

## Implementation status
- ✅ Canonical `/api/v1/credentials`, `/api/v1/credentials/api-key`, `/api/v1/credentials/account`, `/api/v1/credentials/openai/quota`, `/api/v1/credentials/openai/probe`, `/api/v1/credentials/openai/oauth/refresh`, and the credential OAuth/device start+poll routes now reuse the modular credential route layer with a configurable prefix.
- ✅ `/api/v1/credentials/openai/oauth/browser/callback` is now registered as a canonical alias route while `/auth/callback` remains the shared browser callback path used by the OpenAI OAuth manager.
- ✅ Shared credential OAuth/device/browser state is now reused across legacy and canonical route registrations by caching `CredentialRouteContext` per credential store, preventing split pending-state maps during the migration overlap.
- ✅ `/api/v1` migration summary now marks the `credentials` slice as `implemented`.
- ✅ `web/src/lib/api.ts` now uses `/api/v1/credentials*` for credential management, quota/probe, and provider OAuth/device client calls.
- ✅ Backend validation passed with `pnpm run build && node --test --test-concurrency=1 dist/tests/proxy.test.js`.
- ✅ Frontend validation passed with `pnpm web:build` after the client path switch.

## Risks
- browser callback URLs are sensitive to path changes
- route-local pending state maps may be easy to break during extraction
- auth flow code may keep composition concerns mixed with controller logic if moved incompletely

## Definition of done
- credential/admin/provider-auth routes are canonically available under `/api/v1/*`
- frontend uses `/api/v1/*` for this slice
- long-lived OAuth/runtime objects are no longer created directly in the legacy route monolith
- `/api/ui/*` routes for this slice are aliases only
