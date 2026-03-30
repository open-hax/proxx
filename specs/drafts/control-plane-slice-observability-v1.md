# Control-plane slice: observability + operator surfaces v1

## Status
Draft

## Summary
Migrate observability and operator-oriented control-plane routes from `src/lib/ui-routes.ts` into canonical `/api/v1/*` endpoints backed by dedicated services and repositories.

This slice includes dashboard/analytics, request logs, hosts, tools, MCP seed listing, and event tagging APIs. It should be executed after the contract, settings/sessions, and credentials slices, and in parallel with the `request-log-segmentation` refactor where helpful.

## Source specs and notes
- `specs/drafts/control-plane-api-contract-v1.md`
- `specs/lint-complexity-reduction/request-log-segmentation.spec.md`
- `specs/drafts/provider-model-analytics-page.md`
- `specs/drafts/dashboard-usage-window-modes.md`
- `specs/drafts/weekly-cost-water-validation.md`
- `specs/drafts/ussy-host-fleet-dashboard.md`

## Scope

### Dashboard and analytics routes
- `GET /api/v1/dashboard/overview`
- `GET /api/v1/analytics/provider-model`
- `GET /api/v1/request-logs`

### Host/operator inventory routes
- `GET /api/v1/hosts/self`
- `GET /api/v1/hosts/overview`

### Tools and MCP routes
- `GET /api/v1/tools`
- `GET /api/v1/mcp-servers`

### Event routes
- `GET /api/v1/events`
- `GET /api/v1/events/tags`
- `POST /api/v1/events/:id/tag`
- `DELETE /api/v1/events/:id/tag`

### Legacy aliases retained during migration
- corresponding `/api/ui/*` routes remain as aliases

## Out of scope
- federation routes except where they share underlying request-log services
- provider credential/OAuth flows
- `/v1/*` request forwarding endpoints

## Current state
- dashboard, analytics, request-log, host, tool, MCP, and event routes live in `src/lib/ui-routes.ts`
- `buildUsageOverviewFromEntries`, `buildUsageOverview`, and related helpers are large and closely tied to route handlers
- frontend currently calls these endpoints under `/api/ui/*`

## Goals
1. Canonicalize operator/observability routes under `/api/v1/*`.
2. Reuse or extract services for request-log querying and aggregation.
3. Reduce inline aggregation and formatting logic inside route handlers.
4. Preserve payload compatibility for existing UI pages.

## Proposed service/use-case split

### Request-log and analytics services
- `ListRequestLogsService`
- `GetDashboardOverviewService`
- `GetProviderModelAnalyticsService`

### Host/operator services
- `GetHostSelfSnapshotService`
- `GetHostsOverviewService`

### Tool/MCP services
- `ListToolSeedsService`
- `ListMcpServerSeedsService`

### Event services
- `ListEventsService`
- `ListEventTagsService`
- `AddEventTagService`
- `RemoveEventTagService`

## Suggested affected files
- `src/routes/events/index.ts`
- `src/routes/hosts/index.ts`
- `src/routes/mcp/index.ts`
- `src/lib/ui-routes.ts`
- `src/lib/request-log-store.ts`
- `src/lib/host-dashboard.ts`
- `src/lib/tool-mcp-seed.ts`
- `src/lib/db/event-store.ts`
- `web/src/lib/api.ts`
- analytics/dashboard/event tests

## Phases

### Phase A: request-log service extraction
- align with `request-log-segmentation.spec.md`
- create or reuse a request-log query service for request-log list and analytics inputs
- stop embedding request-log querying logic directly in controllers

### Phase B: dashboard and analytics canonical routes
- move dashboard overview and provider-model analytics to `/api/v1/*`
- extract aggregation logic into services or helper modules
- preserve response shapes expected by existing dashboard pages

### Phase C: hosts, tools, MCP, and events routes
- move hosts, tools, mcp-servers, events, and event-tag routes into canonical control-plane route modules
- keep host-dashboard and MCP seed loading behavior stable

### Phase D: frontend switch + alias parity
- update `web/src/lib/api.ts` to use `/api/v1/*` for this slice
- retain `/api/ui/*` aliases
- add parity tests between old and new route surfaces

## Verification
- dashboard/analytics tests still pass
- request-log visibility and filtering tests still pass
- host dashboard tests still pass
- MCP and event route tests still pass
- frontend builds with `/api/v1/*` path changes

## Implementation status
- ✅ Canonical `/api/v1/request-logs`, `/api/v1/dashboard/overview`, `/api/v1/analytics/provider-model`, `/api/v1/tools`, and `/api/v1/mcp-servers` now exist via a dedicated observability route module.
- ✅ Canonical `/api/v1/hosts/self` and `/api/v1/hosts/overview` now exist for the host dashboard surface.
- ✅ Canonical `/api/v1/events`, `/api/v1/events/tags`, and `/api/v1/events/:id/tag` now exist for the event query/tagging surface.
- ✅ `/api/v1` migration summary now marks `observability` and `mcp` as `implemented`.
- ✅ `/api/v1` migration summary now marks `hosts` as `implemented`.
- ✅ `/api/v1` migration summary now marks `events` as `implemented`.
- ✅ `web/src/lib/api.ts` now uses `/api/v1/*` for usage overview, provider-model analytics, request logs, tool seeds, and MCP seed listing.
- ✅ `web/src/lib/api.ts` now uses `/api/v1/hosts/overview` for the host dashboard client surface.
- ✅ Canonical route tests now cover `/api/v1/request-logs`, `/api/v1/dashboard/overview`, `/api/v1/analytics/provider-model`, and `/api/v1/tools`.
- ✅ Canonical route tests now cover `/api/v1/hosts/self` and `/api/v1/hosts/overview`.
- ✅ Canonical route tests now cover `/api/v1/events*` wiring for the missing-store path.
- ✅ Backend validation passed with `pnpm run build && node --test --test-concurrency=1 dist/tests/proxy.test.js`.
- ✅ Frontend validation passed with `pnpm web:build` after the client path switch.
- 🚧 `web/src/lib/api.ts` still has no canonical client helpers for events because the current web console does not use them yet.

## Risks
- aggregation helpers are large and easy to partially migrate incorrectly
- request-log repository work may overlap with this slice and must be coordinated
- observability pages are sensitive to response-shape drift

## Definition of done
- observability/operator routes are canonically available under `/api/v1/*`
- route handlers are thin and reuse request-log/analytics services
- frontend uses `/api/v1/*` for this slice
- `/api/ui/*` versions are aliases only
