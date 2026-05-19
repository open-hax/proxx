import type { ProxyConfig } from "./config.js";
import { getActiveCljsRuntime } from "./cljs-runtime.js";
import type { KeyPool } from "./key-pool.js";
import { isGlmModel } from "./glm-compat.js";
import { allProviderStrategyInfos } from "./provider-strategy/registry.js";
import type { UpstreamMode } from "./provider-strategy/shared.js";

export interface ProviderRoute {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly authRequired?: boolean;
  readonly paths?: Readonly<Record<string, string>>;
}

export interface ProviderRoutesFilterResult {
  readonly providerRoutes: ProviderRoute[];
  readonly strategyMode?: UpstreamMode;
  readonly strategyModeByProvider?: Readonly<Record<string, UpstreamMode>>;
  readonly catalog?: {
    readonly disabled?: boolean;
    readonly rejected?: boolean;
  };
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

const PROVIDER_STRATEGY_INFOS = allProviderStrategyInfos();
const UPSTREAM_MODES = new Set<string>(PROVIDER_STRATEGY_INFOS.map((strategy) => strategy.mode));

function upstreamModeFromRaw(value: unknown): UpstreamMode | undefined {
  const rawMode = isRecord(value) ? value.mode : value;
  if (typeof rawMode !== "string") {
    return undefined;
  }

  return UPSTREAM_MODES.has(rawMode) ? rawMode as UpstreamMode : undefined;
}

function strategyModeByProviderFromRaw(value: unknown): Readonly<Record<string, UpstreamMode>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([providerId, strategy]) => {
    const mode = upstreamModeFromRaw(strategy);
    return mode ? [[providerId, mode] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function providerRoutesFromRaw(rawRoutes: unknown): ProviderRoute[] | undefined {
  if (!Array.isArray(rawRoutes)) {
    return undefined;
  }

  return rawRoutes.flatMap((rawRoute) => {
    if (!isRecord(rawRoute)) {
      return [];
    }

    const providerId = String(rawRoute.providerId ?? rawRoute.provider_id ?? rawRoute["provider-id"] ?? rawRoute["provider/id"] ?? rawRoute.id ?? "").trim();
    const baseUrl = String(rawRoute.baseUrl ?? rawRoute.base_url ?? rawRoute["base-url"] ?? rawRoute["provider/base-url"] ?? "").trim().replace(/\/+$/, "");
    const authRequired = rawRoute.authRequired
      ?? rawRoute.auth_required
      ?? rawRoute["auth-required"]
      ?? rawRoute["auth-required?"]
      ?? rawRoute["auth/required?"]
      ?? rawRoute["required?"];
    const rawPaths = rawRoute.paths;
    const paths = isRecord(rawPaths)
      ? Object.fromEntries(Object.entries(rawPaths).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0))
      : undefined;

    return providerId && baseUrl
      ? [{
          providerId,
          baseUrl,
          ...(typeof authRequired === "boolean" ? { authRequired } : {}),
          ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
        }]
      : [];
  });
}

type ProviderRouteRuntimeConfig = Pick<ProxyConfig, "cljsPolicyManifestPath" | "openaiProviderId" | "openaiBaseUrl" | "upstreamProviderBaseUrls"> & Partial<Pick<ProxyConfig, "ollamaBaseUrl">>;

function applyConfiguredRouteFacts(routes: readonly ProviderRoute[], config: ProviderRouteRuntimeConfig | undefined): ProviderRoute[] {
  if (!config) {
    return [...routes];
  }

  return routes.map((route) => {
    const configuredBaseUrl = route.providerId === config.openaiProviderId
      ? config.openaiBaseUrl
      : route.providerId === "ollama"
        ? config.ollamaBaseUrl
        : config.upstreamProviderBaseUrls[route.providerId];
    return typeof configuredBaseUrl === "string" && configuredBaseUrl.trim().length > 0
      ? { ...route, baseUrl: configuredBaseUrl.trim().replace(/\/+$/, "") }
      : route;
  });
}

function routeIdentity(route: ProviderRoute): string {
  return `${route.providerId}\0${route.baseUrl}`;
}

function enrichFilteredRoute(route: ProviderRoute, inputRoutes: readonly ProviderRoute[]): ProviderRoute {
  const richestFirst = (routes: readonly ProviderRoute[]) => [...routes].sort((left, right) => {
    const leftScore = (left.authRequired === false ? 2 : 0) + (left.paths ? 1 : 0);
    const rightScore = (right.authRequired === false ? 2 : 0) + (right.paths ? 1 : 0);
    return rightScore - leftScore;
  });
  const exactRoute = richestFirst(inputRoutes.filter((inputRoute) => routeIdentity(inputRoute) === routeIdentity(route)))[0];
  const providerRoute = exactRoute ?? richestFirst(inputRoutes.filter((inputRoute) => inputRoute.providerId === route.providerId))[0];
  return providerRoute ? { ...providerRoute, ...route } : route;
}

export function getDeclaredProviderRoutes(configOrManifestPath?: ProviderRouteRuntimeConfig | string): ProviderRoute[] {
  const config = typeof configOrManifestPath === "object" ? configOrManifestPath : undefined;
  const manifestPath = typeof configOrManifestPath === "string" ? configOrManifestPath : configOrManifestPath?.cljsPolicyManifestPath;
  const result = getActiveCljsRuntime()?.getProviderRoutes?.(manifestPath ?? "resources/policies/runtime/00-manifest.edn");
  return result?.status === "ok"
    ? applyConfiguredRouteFacts(providerRoutesFromRaw(result.providerRoutes ?? result["provider-routes"]) ?? [], config)
    : [];
}

export function filterDeclaredProviderRoutes(manifestPath: string | undefined, input: {
  readonly modelId: string;
  readonly requestKind: string;
  readonly tenantSettings: unknown;
  readonly providerRoutes: readonly ProviderRoute[];
  readonly config?: unknown;
  readonly catalogBundle?: unknown;
  readonly catalogAvailability?: boolean;
}): ProviderRoutesFilterResult {
  const runtime = getActiveCljsRuntime();
  if (!runtime?.filterProviderRoutes) {
    return { providerRoutes: [...input.providerRoutes] };
  }

  const result = runtime.filterProviderRoutes(manifestPath ?? "resources/policies/runtime/00-manifest.edn", input);
  if (result.status !== "ok") {
    return { providerRoutes: [...input.providerRoutes] };
  }

  const filteredRoutes = (providerRoutesFromRaw(result.providerRoutes ?? result["provider-routes"]) ?? [...input.providerRoutes])
    .map((route) => enrichFilteredRoute(route, input.providerRoutes));
  const preview = runtime.previewPolicyDecision(manifestPath ?? "resources/policies/runtime/00-manifest.edn", {
    modelId: input.modelId,
    requestKind: input.requestKind,
    tenantSettings: input.tenantSettings,
    providerIds: filteredRoutes.map((route) => route.providerId),
    strategies: PROVIDER_STRATEGY_INFOS,
  });
  const decision = preview.status === "ok" && isRecord(preview.decision)
    ? preview.decision
    : undefined;
  const decisionStatus = typeof decision?.status === "string" ? decision.status : undefined;
  const decisionProviders = Array.isArray(decision?.providers)
    ? decision.providers.filter((providerId): providerId is string => typeof providerId === "string")
    : [];
  const providerById = new Map(filteredRoutes.map((route) => [route.providerId, route]));
  const selectedRoutes = decisionProviders.flatMap((providerId) => {
    const route = providerById.get(providerId);
    return route ? [route] : [];
  });
  const strategyMode = upstreamModeFromRaw(decision?.strategy);
  const strategyModeByProvider = strategyModeByProviderFromRaw(
    decision?.strategyByProvider ?? decision?.["strategy-by-provider"],
  );

  return {
    providerRoutes: decisionStatus === "ok"
      ? selectedRoutes
      : decisionStatus === "denied" || decisionStatus === "exhausted"
        ? []
        : filteredRoutes,
    ...(strategyMode ? { strategyMode } : {}),
    ...(strategyModeByProvider ? { strategyModeByProvider } : {}),
    catalog: result.catalog,
  };
}

export function catalogHasDynamicOllamaModel(
  catalog: Pick<ResolvedModelCatalog, "dynamicOllamaModelIds"> | null | undefined,
  modelId: string,
): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return normalizedModelId.length > 0
    && (catalog?.dynamicOllamaModelIds ?? []).some((candidateModelId) => candidateModelId.trim().toLowerCase() === normalizedModelId);
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
  // Newer Ollama tags sometimes include a leading letter prefix before a size
  // designator (e.g. `:e4b`). Normalize those to the canonical `:4b` form so
  // the default LOCAL_OLLAMA_MODEL_PATTERNS like `:4b` still match.
  const loweredSizeTagNormalized = lowered.replace(/:([a-z]+)(\d+(?:\.\d+)?[bt])/g, ":$2");
  for (const pattern of patterns) {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern.startsWith(":")) {
      if (lowered.includes(normalizedPattern) || loweredSizeTagNormalized.includes(normalizedPattern)) {
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
  const latestAliases = new Map<string, string>();

  for (const modelId of modelIds) {
    const separatorIndex = modelId.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= modelId.length - 1) {
      continue;
    }

    const alias = modelId.slice(0, separatorIndex);
    const modelTag = modelId.slice(separatorIndex + 1);
    const normalizedTag = modelTag.trim().toLowerCase();
    if (normalizedTag === "latest") {
      latestAliases.set(alias, modelId);
    }

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
    } else {
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
  }

  const aliasTargets: Record<string, string> = {};
  for (const [alias, selected] of aliases.entries()) {
    if (!knownModelIds.has(alias)) {
      aliasTargets[alias] = selected.modelId;
    }

    const latestAlias = latestAliases.get(alias);
    if (latestAlias && latestAlias !== selected.modelId) {
      aliasTargets[latestAlias] = selected.modelId;
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
  const localBaseUrl = config.ollamaBaseUrl.trim().replace(/\/+$/, "");
  const localRoute: ProviderRoute | null = config.localOllamaEnabled && localBaseUrl.length > 0
    ? { providerId: "ollama-local", baseUrl: localBaseUrl }
    : null;

  const configuredRoutes = Object.entries(config.upstreamProviderBaseUrls)
    .filter(([providerId]) => providerId.toLowerCase().includes("ollama"))
    .map(([providerId, baseUrl]) => ({
      providerId,
      baseUrl: baseUrl.replace(/\/+$/, "")
    }))
    .filter((route) => route.baseUrl.length > 0);

  const merged = localRoute ? [localRoute, ...configuredRoutes] : configuredRoutes;
  const seen = new Set<string>();
  return merged.filter((route) => {
    const providerId = route.providerId.trim();
    if (providerId.length === 0 || seen.has(providerId)) {
      return false;
    }
    seen.add(providerId);
    return route.baseUrl.trim().length > 0;
  });
}

export function providerIdLooksLikeOllama(providerId: string): boolean {
  return providerId.toLowerCase().includes("ollama");
}

/**
 * Selects and orders provider routes for a given model based on the resolved model catalog and Ollama availability.
 *
 * Uses the catalog to decide whether to keep routes unchanged, prefer Ollama providers, or restrict to non-Ollama providers:
 * - If there is at most one candidate route, returns a shallow copy of `routes`.
 * - If the model is a statically configured model (and not listed as a dynamic Ollama model), returns the routes unchanged.
 * - If no dynamic Ollama models are defined, returns the routes unchanged.
 * - If the model is not known on Ollama and is not a GLM model, returns only non-Ollama routes when any exist; otherwise returns all routes.
 * - Otherwise, returns Ollama routes first followed by non-Ollama routes, preserving relative order within each group.
 *
 * @param routes - Candidate provider routes to filter and order.
 * @param routedModel - The model identifier being routed (compared case-insensitively).
 * @param catalog - Resolved model catalog including `modelIds` and `dynamicOllamaModelIds`.
 * @returns The filtered and/or reordered list of provider routes appropriate for `routedModel`.
 */
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

  if (!modelKnownOnOllama && !isGlmModel(normalizedModel)) {
    const nonOllamaRoutes = routes.filter((route) => !providerIdLooksLikeOllama(route.providerId));
    return nonOllamaRoutes.length > 0 ? nonOllamaRoutes : [...routes];
  }

  const ollamaRoutes = routes.filter((route) => providerIdLooksLikeOllama(route.providerId));
  const nonOllamaRoutes = routes.filter((route) => !providerIdLooksLikeOllama(route.providerId));
  return [...ollamaRoutes, ...nonOllamaRoutes];
}

const OPENAI_COMPATIBLE_API_PROVIDERS = new Set(["vivgrid", "openai", "factory", "requesty", "zen", "xiaomi"]);
const RESPONSES_COMPATIBLE_API_PROVIDERS = new Set(["vivgrid", "openai", "factory", "requesty", "zen", "rotussy"]);

/**
 * Determine whether a provider ID is treated as supporting the OpenAI-compatible API.
 *
 * @param providerId - The provider identifier to check.
 * @param openAiProviderId - Optional configured OpenAI provider identifier that should be treated as OpenAI-compatible when it matches `providerId`.
 * @returns `true` if the provider ID is in the built-in OpenAI-compatible list or equals `openAiProviderId` (case-insensitive), `false` otherwise.
 */
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
