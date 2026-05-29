---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-fallback-extraction-error-classifier-md"
title: "Sub-spec: Error classifier extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.177Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--error-classifier.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--error-classifier.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/fallback-extraction--error-classifier.md`

# Sub-spec: Error classifier extraction

**Epic:** `fallback-extraction-epic.md`
**SP:** 2
**Status:** ✅ Done
**Priority:** P0
**Depends on:** nothing

## Scope
Extract error classification logic from `executeProviderFallback` into `src/lib/provider-strategy/fallback/error-classifier.ts`.

### What moves
- `shouldCooldownCredentialOnAuthFailure()` (already in shared.ts, keep there)
- `shouldPermanentlyDisableCredential()` (already in shared.ts, keep there)
- `isRateLimitResponse()` (already in proxy.ts, keep there)
- The inline decision tree that maps HTTP status + response body to a classification outcome
- `extractRateLimitCooldownMs()` (already in proxy.ts, keep there)

### New code
```typescript
// src/lib/provider-strategy/fallback/error-classifier.ts
export type ErrorClassification =
  | "transient"
  | "rate_limit"
  | "auth_failure"
  | "permanent_disable"
  | "model_not_found"
  | "model_not_supported"
  | "quota_exceeded"
  | "bad_request";

export function classifyErrorResponse(
  response: { status: number; body?: unknown },
  providerId: string,
  config: { openaiProviderId: string },
): ErrorClassification;

export function shouldRetrySame(classification: ErrorClassification): boolean;
export function getCooldownMs(classification: ErrorClassification, responseStatus: number): number | undefined;
```

### Tests
- Unit tests for each classification path (rate limit 429, auth 401/403/402, model not found 404, server error 5xx)
- `shouldRetrySame` returns true only for transient errors
- `getCooldownMs` returns appropriate cooldown durations

## Verification
- `pnpm build` passes
- New unit tests pass
- No behavior changes in existing fallback tests
