import type { ProxyConfig } from "./config.js";
import { isAutoModel } from "./auto-model-selector.js";
import { looksLikeHostedOpenAiFamily, providerIdLooksLikeOllama, type ProviderRoute } from "./provider-routing.js";
import type { ResolvedCatalogWithPreferences } from "./provider-catalog.js";

interface ResolvedModelCatalog {
  readonly modelIds: readonly string[];
  readonly aliasTargets: Readonly<Record<string, string>>;
  readonly dynamicOllamaModelIds: readonly string[];
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function catalogHasDynamicOllamaModel(
  catalog: Pick<ResolvedModelCatalog, "dynamicOllamaModelIds"> | null | undefined,
  modelId: string,
): boolean {
  const normalizedModelId = normalizeModelId(modelId);
  return normalizedModelId.length > 0
    && (catalog?.dynamicOllamaModelIds ?? []).some((candidateModelId) => normalizeModelId(candidateModelId) === normalizedModelId);
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

export function openAiProviderUsesCodexSurface(config: ProxyConfig): boolean {
  const openAiBaseUrl = config.openaiBaseUrl.trim().toLowerCase();
  const openAiResponsesPath = config.openaiResponsesPath.trim().toLowerCase();
  const openAiChatCompletionsPath = config.openaiChatCompletionsPath.trim().toLowerCase();

  return openAiBaseUrl.includes("chatgpt.com/backend-api")
    || openAiResponsesPath.includes("/codex/")
    || openAiChatCompletionsPath.includes("/codex/");
}

export function providerRouteSupportsModel(config: ProxyConfig, providerId: string, modelId: string): boolean {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim().toLowerCase();
  const normalizedOpenAiProviderId = config.openaiProviderId.trim().toLowerCase();

  if (normalizedProviderId === normalizedOpenAiProviderId && !looksLikeHostedOpenAiFamily(normalizedModelId)) {
    return false;
  }

  if (
    normalizedProviderId === normalizedOpenAiProviderId
    && normalizedModelId === "gpt-5.4-nano"
    && openAiProviderUsesCodexSurface(config)
  ) {
    return false;
  }

  return true;
}

export function filterProviderRoutesByModelSupport(
  config: ProxyConfig,
  routes: readonly ProviderRoute[],
  modelId: string,
): ProviderRoute[] {
  return routes.filter((route) => providerRouteSupportsModel(config, route.providerId, modelId));
}

export function filterProviderRoutesByCatalogAvailability(
  providerRoutes: readonly ProviderRoute[],
  routedModel: string,
  catalogBundle: ResolvedCatalogWithPreferences,
): ProviderRoute[] {
  const catalogMatchedRoutes = providerRoutes.filter((route) => {
    const entry = catalogBundle.providerCatalogs[route.providerId];
    return entry?.modelIds.includes(routedModel) ?? false;
  });

  if (catalogMatchedRoutes.length > 0) {
    return catalogMatchedRoutes;
  }

  if (catalogHasDynamicOllamaModel(catalogBundle.catalog, routedModel)) {
    return providerRoutes.filter((route) => providerIdLooksLikeOllama(route.providerId));
  }

  return [...providerRoutes];
}

export function shouldRejectModelFromProviderCatalog(
  providerRoutes: readonly ProviderRoute[],
  routedModel: string,
  catalogBundle: ResolvedCatalogWithPreferences,
): boolean {
  if (catalogBundle.catalog.declaredModelIds.includes(routedModel)) {
    return false;
  }

  let sawCatalogForCandidate = false;

  for (const route of providerRoutes) {
    const entry = catalogBundle.providerCatalogs[route.providerId];
    if (!entry) {
      return false;
    }

    sawCatalogForCandidate = true;
    if (entry.modelIds.includes(routedModel)) {
      return false;
    }
  }

  return sawCatalogForCandidate;
}
