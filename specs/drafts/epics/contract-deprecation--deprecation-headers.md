# Sub-spec: Deprecation headers + parity tests

**Epic:** `contract-deprecation-epic.md`
**SP:** 3
**Priority:** P0
**Status:** Draft
**Depends on:** `contract-deprecation--frontend-migration.md`

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
