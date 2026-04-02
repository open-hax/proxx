# Spec: resolveModelRouting extraction + route handler slimming

**Status:** Partial (Step 1 done)
**Story points:** 3 remaining (of 5 total)
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Finding 3

## What's done
- ✅ `handleRoutingOutcome` extracted to `src/lib/routing-outcome-handler.ts`
- ✅ 80-line error handling block eliminated from chat.ts, responses.ts, images.ts

## What remains

### Step 2: Extract `resolveModelRouting`
Create `src/lib/model-routing-pipeline.ts` that absorbs from route handlers:
- Tenant model-allowed check
- Catalog fetch (single call — fix the double-fetch in chat.ts)
- Disabled-model check
- Alias resolution
- Concrete model ID resolution

```typescript
export async function resolveModelRouting(deps, requestBody): Promise<{
  routingModel: string;
  catalog: ResolvedCatalogWithPreferences | null;
  rejection?: { status: number; code: string; message: string };
}>
```

### Step 3: Slim route handlers
Each handler becomes: parse body → resolveModelRouting → if rejected, send error → build routes → execute → handleRoutingOutcome. ~80 lines shorter per file.

## Verification
- `chat.ts` < 350 lines, `responses.ts` < 300 lines, `images.ts` < 150 lines
- Catalog fetched exactly once per request
- 162/162 proxy tests pass
