import type { ProxyConfig } from "./config.js";
import type { KeyPool } from "./key-pool.js";

export interface ProviderRoute {
  readonly providerId: string;
  readonly baseUrl: string;
}

export interface ResolvedModelCatalog {
  readonly modelIds: readonly string[];
  readonly aliasTargets: Readonly<Record<string, string>>;
  readonly dynamicOllamaModelIds: readonly string[];
  readonly declaredModelIds: readonly string[];
}

export interface RequestRoutingState {
  readonly explicitOllama: boolean;
  readonly openAiPrefixed: boolean;
  readonly factoryPrefixed: boolean;
  readonly localOllama: boolean;
  readonly routedModel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function looksLikeHostedOpenAiFamily(model: string): boolean {
  const lowered = model.toLowerCase();
  return lowered.startsWith("gpt-")
    || lowered.startsWith("openai/")
    || lowered.startsWith("openai:")
    || lowered.startsWith("chatgpt-")
    || lowered === "o1"
    || lowered === "o3"
    || lowered === "o4"
    || lowered.startsWith("o1-")
    || lowered.startsWith("o3-")
    || lowered.startsWith("o4-");
}

export function stripModelPrefix(model: string, prefixes: readonly string[]): string {
  const loweredModel = model.toLowerCase();

  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }

    if (!loweredModel.startsWith(prefix.toLowerCase())) {
      continue;
    }

    const stripped = model.slice(prefix.length).trim();
    return stripped.length > 0 ? stripped : model;
  }

  return model;
}

export function hasModelPrefix(model: string, prefixes: readonly string[]): boolean {
  const loweredModel = model.toLowerCase();
  return prefixes.some((prefix) => prefix.length > 0 && loweredModel.startsWith(prefix.toLowerCase()));
}

export function shouldUseLocalOllama(model: string, patterns: readonly string[]): boolean {
  if (looksLikeHostedOpenAiFamily(model)) {
    return false;
  }

  const lowered = model.toLowerCase();
  for (const pattern of patterns) {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern.startsWith(":")) {
      if (lowered.includes(normalizedPattern)) {
        return true;
      }
      continue;
    }

    if (
      lowered === normalizedPattern
      || lowered.endsWith(`-${normalizedPattern}`)
      || lowered.endsWith(`/${normalizedPattern}`)
      || lowered.endsWith(`:${normalizedPattern}`)
    ) {
      return true;
    }
  }
  return false;
}

export function resolveRequestRoutingState(config: ProxyConfig, requestedModel: string): RequestRoutingState {
  const factoryPrefixed = hasModelPrefix(requestedModel, config.factoryModelPrefixes);
  const explicitOllama = !factoryPrefixed && hasModelPrefix(requestedModel, config.ollamaModelPrefixes);
  const openAiPrefixed = !factoryPrefixed && hasModelPrefix(requestedModel, config.openaiModelPrefixes);
  const localOllama = explicitOllama
    || (!explicitOllama
    && !openAiPrefixed
    && !factoryPrefixed
    && config.localOllamaEnabled
    && shouldUseLocalOllama(requestedModel, config.localOllamaModelPatterns));
  const routedModel = factoryPrefixed
    ? stripModelPrefix(requestedModel, config.factoryModelPrefixes)
    : explicitOllama
      ? stripModelPrefix(requestedModel, config.ollamaModelPrefixes)
      : openAiPrefixed
        ? stripModelPrefix(requestedModel, config.openaiModelPrefixes)
        : requestedModel;

  return {
    explicitOllama,
    openAiPrefixed,
    factoryPrefixed,
    localOllama,
    routedModel
  };
}

export function dedupeModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const modelId of modelIds) {
    const normalized = modelId.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

export function parseModelIdsFromCatalogPayload(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return dedupeModelIds(
      payload.filter((entry): entry is string => typeof entry === "string")
    );
  }

  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload["data"])) {
    const dataModelIds = payload["data"]
      .map((entry) => (isRecord(entry) ? asString(entry["id"]) : undefined))
      .filter((entry): entry is string => typeof entry === "string");

    return dedupeModelIds(dataModelIds);
  }

  if (Array.isArray(payload["models"])) {
    const modelsModelIds = payload["models"]
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (!isRecord(entry)) {
          return undefined;
        }

        return asString(entry["id"]) ?? asString(entry["name"]) ?? asString(entry["model"]);
      })
      .filter((entry): entry is string => typeof entry === "string");

    return dedupeModelIds(modelsModelIds);
  }

  return [];
}

function parseModelScaleScore(modelTag: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)([bt])/i.exec(modelTag);
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = (match[2] ?? "").toLowerCase();
  return unit === "t" ? amount * 1000 : amount;
}

export function buildLargestModelAliases(modelIds: readonly string[]): Record<string, string> {
  const knownModelIds = new Set(modelIds);
  const aliases = new Map<string, { readonly modelId: string; readonly score: number; readonly tagLength: number }>();

  for (const modelId of modelIds) {
    const separatorIndex = modelId.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= modelId.length - 1) {
      continue;
    }

    const alias = modelId.slice(0, separatorIndex);
    const modelTag = modelId.slice(separatorIndex + 1);
    const score = parseModelScaleScore(modelTag);
    if (!score || score <= 0) {
      continue;
    }

    const current = aliases.get(alias);
    if (!current) {
      aliases.set(alias, {
        modelId,
        score,
        tagLength: modelTag.length
      });
      continue;
    }

    const shouldReplace = score > current.score
      || (score === current.score && modelTag.length < current.tagLength)
      || (score === current.score && modelTag.length === current.tagLength && modelId < current.modelId);

    if (shouldReplace) {
      aliases.set(alias, {
        modelId,
        score,
        tagLength: modelTag.length
      });
    }
  }

  const aliasTargets: Record<string, string> = {};
  for (const [alias, selected] of aliases.entries()) {
    if (!knownModelIds.has(alias)) {
      aliasTargets[alias] = selected.modelId;
    }
  }

  return aliasTargets;
}

export type DynamicProviderBaseUrlGetter = (providerId: string) => Promise<string | null | undefined>;

export function createDynamicProviderBaseUrlGetter(
  sqlCredentialStore: { getProviderById: (providerId: string) => Promise<{ baseUrl: string | null } | null> } | undefined
): DynamicProviderBaseUrlGetter | undefined {
  if (!sqlCredentialStore) {
    return undefined;
  }

  return async (providerId: string) => {
    const provider = await sqlCredentialStore.getProviderById(providerId);
    return provider?.baseUrl ?? null;
  };
}

async function routeForProvider(
  config: ProxyConfig,
  providerId: string,
  getDynamicBaseUrl?: DynamicProviderBaseUrlGetter
): Promise<ProviderRoute | null> {
  const normalizedProviderId = providerId.trim();
  if (normalizedProviderId.length === 0) {
    return null;
  }

  if (config.disabledProviderIds.includes(normalizedProviderId)) {
    return null;
  }

  let baseUrl = (normalizedProviderId === config.openaiProviderId
    ? config.openaiBaseUrl
    : config.upstreamProviderBaseUrls[normalizedProviderId] ?? "")
    .trim()
    .replace(/\/+$/, "");

  if (baseUrl.length === 0 && getDynamicBaseUrl) {
    const dynamicBaseUrl = await getDynamicBaseUrl(normalizedProviderId);
    if (dynamicBaseUrl && typeof dynamicBaseUrl === "string") {
      baseUrl = dynamicBaseUrl.trim().replace(/\/+$/, "");
    }
  }

  if (baseUrl.length === 0) {
    return null;
  }

  return {
    providerId: normalizedProviderId,
    baseUrl,
  };
}

export async function buildProviderRoutes(
  config: ProxyConfig,
  useOpenAiUpstream: boolean,
  includeOpenAiFallback: boolean = false
): Promise<ProviderRoute[]> {
  if (useOpenAiUpstream) {
    const routes: ProviderRoute[] = [];
    const seen = new Set<string>();

    for (const providerId of [config.openaiProviderId, config.upstreamProviderId, "factory", ...config.upstreamFallbackProviderIds]) {
      if (seen.has(providerId)) {
        continue;
      }
      seen.add(providerId);

      const route = await routeForProvider(config, providerId);
      if (!route) {
        continue;
      }

      routes.push(route);
    }

    return routes;
  }

  const routes: ProviderRoute[] = [];
  const seen = new Set<string>();
  const providerIds = includeOpenAiFallback
    ? [config.upstreamProviderId, config.openaiProviderId, "factory", ...config.upstreamFallbackProviderIds]
    : [config.upstreamProviderId, "factory", ...config.upstreamFallbackProviderIds];

  for (const providerId of providerIds) {
    if (seen.has(providerId)) {
      continue;
    }
    seen.add(providerId);

    const route = await routeForProvider(config, providerId);
    if (!route) {
      continue;
    }

    routes.push(route);
  }

  return routes;
}

export async function buildProviderRoutesWithDynamicBaseUrls(
  config: ProxyConfig,
  useOpenAiUpstream: boolean,
  getDynamicBaseUrl: DynamicProviderBaseUrlGetter | undefined,
  includeOpenAiFallback: boolean = false
): Promise<ProviderRoute[]> {
  if (useOpenAiUpstream) {
    const routes: ProviderRoute[] = [];
    const seen = new Set<string>();

    for (const providerId of [config.openaiProviderId, config.upstreamProviderId, "factory", ...config.upstreamFallbackProviderIds]) {
      if (seen.has(providerId)) {
        continue;
      }
      seen.add(providerId);

      const route = await routeForProvider(config, providerId, getDynamicBaseUrl);
      if (!route) {
        continue;
      }

      routes.push(route);
    }

    return routes;
  }

  const routes: ProviderRoute[] = [];
  const seen = new Set<string>();
  const providerIds = includeOpenAiFallback
    ? [config.upstreamProviderId, config.openaiProviderId, "factory", ...config.upstreamFallbackProviderIds]
    : [config.upstreamProviderId, "factory", ...config.upstreamFallbackProviderIds];

  for (const providerId of providerIds) {
    if (seen.has(providerId)) {
      continue;
    }
    seen.add(providerId);

    const route = await routeForProvider(config, providerId, getDynamicBaseUrl);
    if (!route) {
      continue;
    }

    routes.push(route);
  }

  return routes;
}

export async function minMsUntilAnyProviderKeyReady(keyPool: KeyPool, routes: readonly ProviderRoute[]): Promise<number> {
  let minReadyInMs = 0;

  for (const route of routes) {
    try {
      const retryInMs = await keyPool.msUntilAnyKeyReady(route.providerId);
      if (retryInMs > 0 && (minReadyInMs === 0 || retryInMs < minReadyInMs)) {
        minReadyInMs = retryInMs;
      }
    } catch {
      // Ignore status errors and keep evaluating other providers.
    }
  }

  return minReadyInMs;
}

export function buildOllamaCatalogRoutes(config: ProxyConfig): ProviderRoute[] {
  return Object.entries(config.upstreamProviderBaseUrls)
    .filter(([providerId]) => providerId.toLowerCase().includes("ollama"))
    .map(([providerId, baseUrl]) => ({
      providerId,
      baseUrl: baseUrl.replace(/\/+$/, "")
    }))
    .filter((route) => route.baseUrl.length > 0);
}

export function providerIdLooksLikeOllama(providerId: string): boolean {
  return providerId.toLowerCase().includes("ollama");
}

export function resolveProviderRoutesForModel(
  routes: readonly ProviderRoute[],
  routedModel: string,
  catalog: ResolvedModelCatalog
): ProviderRoute[] {
  if (routes.length <= 1) {
    return [...routes];
  }

  const normalizedModel = routedModel.trim().toLowerCase();
  const configuredModels = new Set(
    catalog.modelIds.map((modelId) => modelId.trim().toLowerCase()).filter((modelId) => modelId.length > 0)
  );
  if (configuredModels.has(normalizedModel) && !catalog.dynamicOllamaModelIds.some((modelId) => modelId.trim().toLowerCase() === normalizedModel)) {
    return [...routes];
  }

  const dynamicOllamaModels = new Set(
    catalog.dynamicOllamaModelIds.map((modelId) => modelId.trim().toLowerCase()).filter((modelId) => modelId.length > 0)
  );
  if (dynamicOllamaModels.size === 0) {
    return [...routes];
  }
  const modelKnownOnOllama = dynamicOllamaModels.has(normalizedModel);

  if (!modelKnownOnOllama) {
    const nonOllamaRoutes = routes.filter((route) => !providerIdLooksLikeOllama(route.providerId));
    return nonOllamaRoutes.length > 0 ? nonOllamaRoutes : [...routes];
  }

  const ollamaRoutes = routes.filter((route) => providerIdLooksLikeOllama(route.providerId));
  const nonOllamaRoutes = routes.filter((route) => !providerIdLooksLikeOllama(route.providerId));
  return [...ollamaRoutes, ...nonOllamaRoutes];
}

const OPENAI_COMPATIBLE_API_PROVIDERS = new Set(["vivgrid", "openai", "factory", "requesty", "zen"]);
const RESPONSES_COMPATIBLE_API_PROVIDERS = new Set(["vivgrid", "openai", "factory", "requesty", "zen", "rotussy"]);

function providerSupportsOpenAiCompatibleApi(providerId: string, openAiProviderId?: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  if (OPENAI_COMPATIBLE_API_PROVIDERS.has(normalized)) {
    return true;
  }

  const normalizedOpenAiProviderId = openAiProviderId?.trim().toLowerCase();
  return typeof normalizedOpenAiProviderId === "string"
    && normalizedOpenAiProviderId.length > 0
    && normalized === normalizedOpenAiProviderId;
}

export function providerSupportsResponsesApi(providerId: string, openAiProviderId?: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  if (RESPONSES_COMPATIBLE_API_PROVIDERS.has(normalized)) {
    return true;
  }

  const normalizedOpenAiProviderId = openAiProviderId?.trim().toLowerCase();
  return typeof normalizedOpenAiProviderId === "string"
    && normalizedOpenAiProviderId.length > 0
    && normalized === normalizedOpenAiProviderId;
}

export function filterResponsesApiRoutes(routes: readonly ProviderRoute[], openAiProviderId?: string): ProviderRoute[] {
  return routes.filter((route) => providerSupportsResponsesApi(route.providerId, openAiProviderId));
}

export function providerSupportsImagesApi(providerId: string, openAiProviderId?: string): boolean {
  return providerSupportsOpenAiCompatibleApi(providerId, openAiProviderId);
}

export function filterImagesApiRoutes(routes: readonly ProviderRoute[], openAiProviderId?: string): ProviderRoute[] {
  return routes.filter((route) => providerSupportsImagesApi(route.providerId, openAiProviderId));
}
