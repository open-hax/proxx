---
uuid: "9ee80298-7d5d-4366-b3be-f3b06dcf102a"
title: "Sub-spec: Deprecation headers + parity tests"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.147Z"
source: "kanban/drafts/epics/contract-deprecation--deprecation-headers.md"
category: "specs"
---

> Source: `kanban/drafts/epics/contract-deprecation--deprecation-headers.md`
> Migrated-to-kanban: `kanban/drafts/epics/contract-deprecation--deprecation-headers.md`

# Sub-spec: Deprecation headers + parity tests

**Epic:** `contract-deprecation-epic.md`
**SP:** 3
**Priority:** P0
**Status:** ✅ Done (prior session)

## Findings
- `registerUiRoutes` in `ui-routes.ts:29-35` already adds `Deprecation: true` and `Link` headers
- Live verification: `curl -I /api/ui/settings` returns both headers
- `Deprecation: true` and `Link: </api/v1/settings>; rel="successor-version"` confirmed

## Scope
Add `Deprecation: true` and `Link` headers to all `/api/ui/*` responses, and add parity tests confirming identical behavior at both prefixes.

### Changes
1. Add a Fastify hook or middleware that sets `Deprecation: true` on all `/api/ui/*` responses
2. Add `Link: </api/v1/...>; rel="successor-version"` header pointing to the canonical equivalent
3. Create `src/tests/parity.test.ts` with test pairs:
```typescript
const PARITY_PAIRS = [
  ["/api/ui/credentials", "/api/v1/credentials"],
  ["/api/ui/sessions", "/api/v1/sessions"],
  ["/api/ui/settings", "/api/v1/settings"],
  // ... all pairs
];
```
4. Each test confirms same status code and response body shape

## Verification
- `curl -I http://localhost:8789/api/ui/credentials` shows `Deprecation: true`
- All parity tests pass
- `pnpm build` passes
