import type { ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ResolvedModelCatalog } from "./provider-routing.js";
import { isAutoModel } from "./auto-model-selector.js";

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

export function withResolvedRequestModel(
  requestBody: Readonly<Record<string, unknown>>,
  resolvedModel: string,
): Record<string, unknown> {
  if (requestBody.model === resolvedModel) {
    return { ...requestBody };
  }

  return {
    ...requestBody,
    model: resolvedModel,
  };
}
