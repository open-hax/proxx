# Spec: Fastify type augmentation for openHaxAuth

**Status:** Draft
**Story points:** 2
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Finding 4

## Problem

`app.ts:678` decorates the Fastify request with `openHaxAuth`:
```typescript
app.decorateRequest("openHaxAuth", null);
```

But there is no `declare module "fastify"` augmentation. TypeScript doesn't know the property exists, so every route handler must cast:
```typescript
(request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | ...; readonly tenantId?: string; ... } }).openHaxAuth
```

This pattern appears **55 times across 19 files**. The inline type literal is a drift risk — if `ResolvedRequestAuth` changes shape, none of the 55 cast sites will catch it.

## Scope

### Step 1: Add Fastify type augmentation

Create or extend `src/lib/fastify-types.ts`:

```typescript
import type { ResolvedRequestAuth } from "./request-auth.js";

declare module "fastify" {
  interface FastifyRequest {
    openHaxAuth: ResolvedRequestAuth | null;
    _otelSpan: import("./telemetry/otel.js").TelemetrySpan | null;
  }
}
```

### Step 2: Remove all ad-hoc casts

Replace every instance of:
```typescript
(request as { readonly openHaxAuth?: { ... } }).openHaxAuth
```
with:
```typescript
request.openHaxAuth
```

The affected files (19 total, sorted by occurrence count):
- `federation/ui.ts` (20)
- `chat.ts` (4)
- `responses.ts` (4)
- `images.ts` (3)
- `bridge/lease.ts` (3)
- `observability/index.ts` (3)
- `embeddings.ts` (2)
- `hosts/index.ts` (2)
- `models.ts` (2)
- `api/ui/hosts/index.ts` (2)
- `api/ui/analytics/usage.ts` (2)
- `settings/*.ts` (6 files, 1 each)

### Step 3: Remove the `DecoratedAppRequest` type alias from `app.ts`

`app.ts:673-676` defines a local `DecoratedAppRequest` type. After augmentation, this is unnecessary.

## Non-goals

- Changing `ResolvedRequestAuth` shape
- Refactoring the auth resolution logic in `app.ts`

## Verification

- `pnpm build` passes (strict mode, no `as` casts for `openHaxAuth`)
- `rg "as \{ readonly openHaxAuth" src/` returns zero results
- `rg "DecoratedAppRequest" src/` returns zero results
- All existing auth-related tests pass
