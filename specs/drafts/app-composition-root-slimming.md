# Spec: app.ts composition root slimming

**Status:** Draft
**Story points:** 5
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Findings 5, 9
**Related:** `specs/drafts/control-plane-mvc-transition-roadmap.md` Decision 6, Decision 7

## Problem

`createApp` in `src/app.ts` is 1025 lines. While `ui-routes.ts` was successfully reduced to a thin shim, `app.ts` absorbed the god-file role. It contains inline:

- **Token refresh business logic** (lines 287-457): `refreshFactoryAccount`, `refreshExpiredOAuthAccount`, `ensureFreshAccounts`, and the `TokenRefreshManager` callback — 170 lines of provider-specific OAuth/WorkOS refresh logic
- **Auth hook with embedded policy** (lines 680-794): bridge auth resolution, tenant quota enforcement, session resolution — 114 lines
- **HTML landing page** (lines 481-514): 33 lines of template string
- **~20 inline OPTIONS handlers** (lines 817-892): boilerplate `reply.code(204).send()`
- **Dual dependency wiring** (lines 894-951): constructs both `AppDeps` and `UiRouteDependencies` separately

This violates roadmap Decision 6 ("controllers stay thin") and Decision 7 ("composition/runtime objects belong in the composition root") because the composition root has become a grab-bag of business logic.

## Scope

### Step 1: Extract token refresh logic → `src/lib/token-refresh-handlers.ts`

Move the three functions and the `TokenRefreshManager` construction callback:

```typescript
// token-refresh-handlers.ts
export function createOpenAiRefreshHandler(deps: { ... }): (credential: ProviderCredential) => Promise<ProviderCredential | null>;
export function createFactoryRefreshHandler(deps: { ... }): (credential: ProviderCredential) => Promise<ProviderCredential | null>;
export function createEnsureFreshAccounts(deps: { ... }): (providerId: string) => Promise<void>;
```

`app.ts` calls these factory functions, passing in the stores. The 170 lines of inline logic becomes ~15 lines of wiring.

### Step 2: Extract tenant quota enforcement → `src/lib/tenant-quota-hook.ts`

Move the quota check from the `onRequest` hook into a reusable function:

```typescript
export async function enforceTenantQuota(
  deps: { requestLogStore: RequestLogStore; proxySettingsStore: ProxySettingsStore },
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean>; // true if rejected
```

### Step 3: Extract bridge auth resolution → `src/lib/bridge-auth-hook.ts`

Move the `x-open-hax-bridge-auth` + federation header resolution into a focused function.

### Step 4: Batch OPTIONS handlers

Replace ~20 individual `app.options(...)` handlers with a single wildcard or a loop:

```typescript
const OPTION_PATHS = ["/health", "/v1/chat/completions", "/v1/responses", ...];
for (const path of OPTION_PATHS) {
  app.options(path, async (_request, reply) => { reply.code(204).send(); });
}
```

### Step 5: Unify `AppDeps` and `UiRouteDependencies`

Make `UiRouteDependencies` extend or be a subset of `AppDeps`, or create a single `RuntimeDeps` type that both use. Eliminate the dual construction at lines 894-951.

## Non-goals

- Moving route registration out of `createApp` (that's the route orchestrator spec)
- Rewriting the policy engine
- Changing the auth resolution algorithm itself

## Verification

- `pnpm build` passes
- `createApp` body < 400 lines (from 1025)
- All existing proxy and auth tests pass
- `rg "refreshFactoryAccount|refreshExpiredOAuthAccount|ensureFreshAccounts" src/app.ts` returns only the factory function calls, not the logic
- `rg "app\.options\(" src/app.ts | wc -l` returns < 5
