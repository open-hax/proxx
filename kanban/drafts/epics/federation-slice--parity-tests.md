---
uuid: "inbox-worktrees-proxx-pr-156-coderabbit-kanban-inbox-worktrees-proxx-pr-156-coderabbit-specs-drafts-epics-federation-slice-parity-tests-md"
title: "Sub-spec: Federation parity tests + legacy alias verification"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.141Z"
source: "inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/epics/federation-slice--parity-tests.md"
category: "specs"
---

> Source: `inbox/worktrees/proxx-pr-156-coderabbit/specs/drafts/epics/federation-slice--parity-tests.md`
> Migrated-to-kanban: `inbox/worktrees/proxx-pr-156-coderabbit/kanban/drafts/epics/federation-slice--parity-tests.md`

# Sub-spec: Federation parity tests + legacy alias verification

**Epic:** `federation-slice-epic.md`
**SP:** 2
**Priority:** P1
**Depends on:** `federation-slice--advanced-routes.md`, `federation-slice--bridge-relay-lifecycle.md`

## Scope
Add parity tests that confirm every `/api/ui/federation/*` endpoint returns an identical response to its `/api/v1/federation/*` canonical equivalent.

### Tests
```typescript
// src/tests/federation-parity.test.ts
const PARITY_PAIRS = [
  ["/api/ui/federation/self", "/api/v1/federation/self"],
  ["/api/ui/federation/peers", "/api/v1/federation/peers"],
  ["/api/ui/federation/accounts", "/api/v1/federation/accounts"],
  ["/api/ui/federation/accounts/export", "/api/v1/federation/accounts/export"],
  ["/api/ui/federation/bridges", "/api/v1/federation/bridges"],
  ["/api/ui/federation/diff-events", "/api/v1/federation/diff-events"],
  ["/api/ui/federation/tenant-provider-policies", "/api/v1/federation/tenant-provider-policies"],
  ["/api/ui/federation/projected-accounts/routed", "/api/v1/federation/projected-accounts/routed"],
  ["/api/ui/federation/projected-accounts/imported", "/api/v1/federation/projected-accounts/imported"],
  ["/api/ui/federation/usage-export", "/api/v1/federation/usage-export"],
];

test("parity: each legacy endpoint returns same response as canonical", async () => {
  for (const [legacy, canonical] of PARITY_PAIRS) {
    const legacyRes = await fetch(legacy);
    const canonicalRes = await fetch(canonical);
    assert.equal(legacyRes.status, canonicalRes.status);
    assert.deepEqual(await legacyRes.json(), await canonicalRes.json());
  }
});
```

### Also verify
- WebSocket upgrade rejects cross-origin/unauthorized requests at both paths
- Tenant-scoped bridge visibility holds at canonical path

## Verification
- `pnpm build` passes
- All parity tests pass
- WebSocket auth tests pass
