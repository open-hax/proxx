---
uuid: "orgs-open-hax-proxx-kanban-orgs-open-hax-proxx-specs-drafts-epics-fallback-extraction-credential-selector-md"
title: "Sub-spec: Credential selector extraction"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:44.189Z"
source: "orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--credential-selector.md"
category: "specs"
---

> Source: `orgs/open-hax/proxx/specs/drafts/epics/fallback-extraction--credential-selector.md`
> Migrated-to-kanban: `orgs/open-hax/proxx/kanban/drafts/epics/fallback-extraction--credential-selector.md`

# Sub-spec: Credential selector extraction

**Epic:** `fallback-extraction-epic.md`
**SP:** 2
**Status:** ✅ Done
**Priority:** P0
**Depends on:** `fallback-extraction--error-classifier.md` ✅

## Scope
Extract credential ordering and selection logic from `executeProviderFallback` into `src/lib/provider-strategy/fallback/credential-selector.ts`.

### What moves
- `providerAccountsForRequest()` (currently in shared.ts)
- `providerAccountsForRequestWithPolicy()` (currently in shared.ts)
- `reorderAccountsForLatency()` (currently in shared.ts)
- `reorderCandidatesForAffinities()` (currently in shared.ts)
- Affinity preference resolution (sticky accounts from prompt affinity store)
- Policy engine reordering integration

### New code
```typescript
// src/lib/provider-strategy/fallback/credential-selector.ts
export interface CredentialSelectionConfig {
  readonly providerId: string;
  readonly keyPool: KeyPoolInterface;
  readonly promptAffinityStore?: PromptAffinityStore;
  readonly policyEngine?: PolicyEngine;
  readonly modelId: string;
  readonly promptCacheKey?: string;
}

export async function selectAndOrderCredentials(
  config: CredentialSelectionConfig,
): Promise<ProviderCredential[]>;
```

### Tests
- Unit tests for affinity-based reordering
- Unit tests for policy-based filtering
- Unit tests for latency-based reordering
- Integration test: full selection pipeline with mock key pool

## Verification
- `pnpm build` passes
- New unit tests pass
- `reorderCandidatesForAffinities`, `providerAccountsForRequest`, etc. re-exported from credential-selector.ts for backward compat
