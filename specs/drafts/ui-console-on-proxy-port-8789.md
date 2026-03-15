# Spec Draft: Serve UI console on proxy port (8789) even when proxy auth is enabled

## Problem
When `PROXY_AUTH_TOKEN` is configured, the proxy currently requires auth for **all** routes except a small callback allowlist. As a result, visiting `http://localhost:8789/` (or any UI route) returns `401 Unauthorized` JSON, which prevents the React console from loading. This creates a UX dead-end: you need the UI to enter the proxy token (cookie/localStorage), but you can’t load the UI without already having the token in the browser.

## Goal
- The SPA shell (`/`, `/chat`, `/images`, `/credentials`, `/tools`) and its static assets (`/assets/*`) must be reachable **without** proxy auth.
- The API surfaces (`/v1/*`, `/api/*`) must remain protected by `PROXY_AUTH_TOKEN`.

## Non-goals
- Changing the proxy auth scheme.
- Making `/api/ui/*` endpoints unauthenticated.

## Proposed change
In `src/app.ts` auth hook, expand the unauthenticated allowlist to include:
- `GET` (and `HEAD`) requests to SPA routes: `/`, `/chat`, `/images`, `/credentials`, `/tools`
- `GET`/`HEAD` to `/assets/*`

All other routes continue to require bearer/cookie auth when `PROXY_AUTH_TOKEN` is set.

## Risks
- Slight information disclosure: an unauthenticated user can load the UI shell. However, the UI does not grant proxy access without a valid token, and API endpoints remain protected.

## Test plan (regression)
Add a test that, with `proxyAuthToken` configured:
- `GET /` returns 200 (HTML or fallback JSON)
- `GET /assets/<hashed>.js` returns 200 when UI is present
- `GET /api/ui/settings` remains 401 without auth

## Affected files
- `src/app.ts`
- `src/tests/proxy.test.ts` (add regression coverage)
- (optional docs) `README.md`

## Definition of done
- Browser can load the UI from `http://localhost:8789/` with `PROXY_AUTH_TOKEN` enabled.
- Tests pass (`pnpm test`).
