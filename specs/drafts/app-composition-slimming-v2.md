# Spec: Extract token refresh + unify deps from app.ts

**Status:** Partial (Step 4 done)
**Story points:** 4 remaining (of 5 total)
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Findings 5, 9

## What's done
- ✅ ~20 inline OPTIONS handlers batched into a loop
- ✅ `DecoratedAppRequest` type removed, Fastify augmentation added
- ✅ app.ts reduced from 1025 → ~970 lines

## What remains

### Step 1: Extract token refresh → `src/lib/token-refresh-handlers.ts`
Move ~90 lines of `refreshFactoryAccount`, `refreshExpiredOAuthAccount`, `ensureFreshAccounts` and the `TokenRefreshManager` callback into factory functions:
```typescript
export function createOpenAiRefreshHandler(deps): (cred) => Promise<cred|null>
export function createFactoryRefreshHandler(deps): (cred) => Promise<cred|null>
export function createEnsureFreshAccounts(deps): (providerId) => Promise<void>
```
app.ts wiring: ~15 lines instead of ~90.

### Step 2: Unify `AppDeps` and `UiRouteDependencies`
Make `UiRouteDependencies` extend `AppDeps` or create a single `RuntimeDeps`. Eliminate dual construction.

### Step 3: Extract tenant quota + bridge auth from onRequest hook
Move quota enforcement and bridge auth resolution into reusable functions.

## Verification
- `createApp` body < 500 lines
- No duplicate `refreshFactoryAccount`/`refreshExpiredOAuthAccount` logic
- Single `RuntimeDeps` construction site
- 162/162 proxy tests pass
