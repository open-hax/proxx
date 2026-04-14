# Sub-spec: ModelCatalog admission gate

**Epic:** `model-catalog-planner-epic.md`
**SP:** 3
**Status:** Draft
**Priority:** P1
**Depends on:** `model-family-registry.md` (3 SP), `routing-pipeline-extraction.md` Step 2 (3 SP remaining)

## Scope

Create the `ModelCatalog` admission gate: the hard boundary that prevents any provider from being attempted for a model it cannot serve. Initially wired as a pass-through (logs but doesn't gate) to allow safe incremental adoption.

### New code

```typescript
// src/lib/catalog/ModelCatalog.ts

export interface CatalogProviderEntry {
  readonly providerId: string;
  readonly stale: boolean;
  readonly discoveredAt: Date;
}

export interface ModelCatalog {
  /** Is this provider known to serve this model? */
  canServe(providerId: string, modelId: string): boolean;

  /** All providers known to serve this model, with staleness metadata. */
  providersForModel(modelId: string): ReadonlyArray<CatalogProviderEntry>;

  /** Refresh catalog for a specific provider or all providers. */
  refresh(providerId?: string): Promise<void>;
}
```

```typescript
// src/lib/catalog/PreferenceOverlay.ts

export interface PreferenceOverlay {
  /** Models that get a routing priority boost. */
  readonly preferred: readonly string[];

  /** Models excluded from routing even if discovered. */
  readonly disabled: readonly string[];

  /** Aliases applied after discovery. */
  readonly aliases: ReadonlyMap<string, string>;
}

export function loadPreferenceOverlay(modelsJson: unknown): PreferenceOverlay;
```

```typescript
// src/lib/catalog/ModelNameAliases.ts

/** Resolve an alias to a concrete model ID. Aliases apply at request-parsing time only. */
export function resolveAlias(modelId: string, overlay: PreferenceOverlay): string;
```

### Implementation approach

- `ModelCatalog` wraps the existing `ProviderCatalogStore` (from `dynamic-provider-model-discovery.md`), adding `canServe()` and `providersForModel()` query APIs on top of the discovery data.
- `PreferenceOverlay` reinterprets the current `models.json` shape as preferences rather than the canonical model list. The existing `loadModels()` function continues to work; `PreferenceOverlay` is an additional read path.
- Initially, `ModelCatalog` is wired into routing as a **logging pass-through**: `canServe()` always returns `true`, but logs when a provider would have been rejected. This lets us validate catalog coverage before turning on the hard gate.

### Integration point

- `RoutingPlanner.plan()` (from sub-spec 6) will call `ModelCatalog.providersForModel()` as its first step.
- `resolveModelRouting()` (from `routing-pipeline-extraction.md`) will call `PreferenceOverlay` for alias resolution and disabled-model checks.

## Verification

- [ ] `src/lib/catalog/ModelCatalog.ts` created with `canServe()`, `providersForModel()`, `refresh()`
- [ ] `src/lib/catalog/PreferenceOverlay.ts` created with `loadPreferenceOverlay()`
- [ ] `src/lib/catalog/ModelNameAliases.ts` created with `resolveAlias()`
- [ ] Integration test: request for a model not in any provider's catalog → logged rejection (pass-through still routes, but log confirms gate would have fired)
- [ ] `pnpm build` passes
- [ ] All existing proxy tests pass
