# Plan: Fast Mode Visibility Follow-ups

## Goal
Add UI and observability follow-ups for the new global fast-mode / priority-tier feature.

## 1. Dashboard badge for global fast mode
- Read `GET /api/ui/settings` in `web/src/pages/DashboardPage.tsx`.
- Add a compact status badge in the dashboard hero/header area.
- States:
  - `Fast mode on` when `fastMode === true`
  - `Fast mode off` when `fastMode === false`
  - optional loading/error fallback if settings fetch fails
- Reuse the existing visual language from header/toggle badges so the state is obvious at a glance.

## 2. Request log tagging for priority-tier traffic
- Extend request logging to capture whether a proxied request used `service_tier`, especially `priority`.
- Best source of truth: log the resolved upstream payload after fast-mode injection / request-level override logic has been applied.
- Update `RequestLogEntry` shape and storage to include:
  - `serviceTier?: string`
  - optionally `fastModeApplied?: boolean` if we want to distinguish global injection vs explicit caller tier
- Surface the field in:
  - backend request-log serialization
  - `web/src/lib/api.ts` types
  - dashboard/request-log UI rows/cards
- Add tests covering:
  - global fast mode produces request-log tag `priority`
  - explicit `service_tier` requests log their chosen tier
  - non-Responses requests remain untagged unless explicitly supported

## 3. Validation
- `pnpm build`
- `pnpm test`
- `pnpm web:build`
- Rebuild container and verify:
  - dashboard badge reflects current state
  - request logs visibly mark priority-tier requests
