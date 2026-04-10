import type { ProxyConfig } from "./config.js";
import { isAutoModel } from "./auto-model-selector.js";
import type { ResolvedCatalogWithPreferences } from "./provider-catalog.js";

interface ResolvedModelCatalog {
  readonly modelIds: readonly string[];
  readonly aliasTargets: Readonly<Record<string, string>>;
  readonly dynamicOllamaModelIds: readonly string[];
}

export function resolvableConcreteModelIds(catalog: ResolvedModelCatalog | null): string[] | undefined {
  if (!catalog) {
    return undefined;
  }

  return catalog.modelIds.filter((modelId) => !isAutoModel(modelId) && catalog.aliasTargets[modelId] === undefined);
}

export function resolvableConcreteModelIdsForProviders(
  catalogBundle: ResolvedCatalogWithPreferences | null,
  providerIds: readonly string[],
  includeDeclaredModel?: (modelId: string) => boolean,
): string[] | undefined {
  if (!catalogBundle) {
    return undefined;
  }

  const ids: string[] = [];
  for (const modelId of catalogBundle.catalog.declaredModelIds) {
    if (
      isAutoModel(modelId)
      || catalogBundle.catalog.aliasTargets[modelId] !== undefined
      || (includeDeclaredModel && !includeDeclaredModel(modelId))
    ) {
      continue;
    }
    ids.push(modelId);
  }

  for (const providerId of providerIds) {
    const entry = catalogBundle.providerCatalogs[providerId];
    if (!entry) {
      continue;
    }
    for (const modelId of entry.modelIds) {
      if (isAutoModel(modelId) || catalogBundle.catalog.aliasTargets[modelId] !== undefined) {
        continue;
      }
      ids.push(modelId);
    }
  }

  return [...new Set(ids)];
}
