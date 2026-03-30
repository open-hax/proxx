import type { ProxyConfig } from "./config.js";
import type { ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ProviderRoute } from "./provider-routing.js";

type ModelFamily =
  | "openai"
  | "anthropic"
  | "google"
  | "zhipu"
  | "deepseek"
  | "moonshotai"
  | "qwen";

const MODEL_FAMILY_PROVIDER_PREFERENCES: Readonly<Record<ModelFamily, readonly string[]>> = {
  openai: ["openai", "requesty", "openrouter", "factory", "vivgrid"],
  anthropic: ["requesty", "openrouter", "factory", "vivgrid"],
  google: ["requesty", "openrouter", "gemini"],
  zhipu: ["requesty", "zai"],
  deepseek: ["requesty", "openrouter"],
  moonshotai: ["requesty", "openrouter"],
  qwen: ["requesty", "openrouter"],
};

function openAiProviderUsesCodexSurface(config: ProxyConfig): boolean {
  const openAiBaseUrl = config.openaiBaseUrl.trim().toLowerCase();
  const openAiResponsesPath = config.openaiResponsesPath.trim().toLowerCase();
  const openAiChatCompletionsPath = config.openaiChatCompletionsPath.trim().toLowerCase();

  return openAiBaseUrl.includes("chatgpt.com/backend-api")
    || openAiResponsesPath.includes("/codex/")
    || openAiChatCompletionsPath.includes("/codex/");
}

function inferModelFamily(modelId: string): ModelFamily | undefined {
  const normalized = modelId.trim().toLowerCase();

  if (normalized.startsWith("gpt-") || normalized.startsWith("chatgpt-") || normalized === "o1" || normalized === "o3" || normalized === "o4" || normalized.startsWith("o1-") || normalized.startsWith("o3-") || normalized.startsWith("o4-")) {
    return "openai";
  }
  if (normalized.startsWith("claude-")) {
    return "anthropic";
  }
  if (normalized.startsWith("gemini-")) {
    return "google";
  }
  if (normalized.startsWith("glm-")) {
    return "zhipu";
  }
  if (normalized.startsWith("deepseek")) {
    return "deepseek";
  }
  if (normalized.startsWith("kimi-")) {
    return "moonshotai";
  }
  if (normalized.startsWith("qwen")) {
    return "qwen";
  }

  return undefined;
}

function normalizeProviderId(providerId: string, openAiProviderId: string): string {
  const normalized = providerId.trim().toLowerCase();
  return normalized === openAiProviderId.trim().toLowerCase() ? "openai" : normalized;
}

function providerCatalogHasModel(
  catalogBundle: ResolvedCatalogWithPreferences,
  providerId: string,
  modelId: string,
): boolean {
  const entry = catalogBundle.providerCatalogs[providerId];
  return Boolean(entry?.modelIds.includes(modelId));
}

function providerAffinityScore(
  providerId: string,
  family: ModelFamily,
  openAiProviderId: string,
): number {
  const normalizedProviderId = normalizeProviderId(providerId, openAiProviderId);
  const preferredProviders = MODEL_FAMILY_PROVIDER_PREFERENCES[family];
  const preferredIndex = preferredProviders.indexOf(normalizedProviderId);
  return preferredIndex >= 0 ? preferredIndex : Number.POSITIVE_INFINITY;
}

function stableSortRoutes(
  routes: readonly ProviderRoute[],
  scoreFor: (route: ProviderRoute) => number,
): ProviderRoute[] {
  return routes
    .map((route, index) => ({ route, index, score: scoreFor(route) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.route);
}

export function filterProviderRoutesByModelSupport(
  config: ProxyConfig,
  routes: readonly ProviderRoute[],
  modelId: string,
  catalogBundle?: ResolvedCatalogWithPreferences | null,
): ProviderRoute[] {
  const normalizedModelId = modelId.trim().toLowerCase();

  const basicFiltered = routes.filter((route) => {
    const normalizedProviderId = normalizeProviderId(route.providerId, config.openaiProviderId);
    return !(
      normalizedProviderId === "openai"
      && normalizedModelId === "gpt-5.4-nano"
      && openAiProviderUsesCodexSurface(config)
    );
  });

  if (!catalogBundle) {
    return [...basicFiltered];
  }

  const family = inferModelFamily(modelId);
  const explicitCatalogMatches = basicFiltered.filter((route) => providerCatalogHasModel(catalogBundle, route.providerId, modelId));

  if (!family) {
    return explicitCatalogMatches.length > 0 ? explicitCatalogMatches : [...basicFiltered];
  }

  if (explicitCatalogMatches.length > 0 && family !== "openai") {
    return stableSortRoutes(
      explicitCatalogMatches,
      (route) => {
        const affinity = providerAffinityScore(route.providerId, family, config.openaiProviderId);
        return Number.isFinite(affinity) ? affinity : 100;
      },
    );
  }

  const familyCompatibleRoutes = basicFiltered.filter((route) => Number.isFinite(providerAffinityScore(route.providerId, family, config.openaiProviderId)));
  if (familyCompatibleRoutes.length === 0) {
    return [...basicFiltered];
  }

  return stableSortRoutes(
    family === "openai" ? basicFiltered : familyCompatibleRoutes,
    (route) => providerAffinityScore(route.providerId, family, config.openaiProviderId),
  );
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
