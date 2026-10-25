import type { ProxyConfig } from "./config.js";
import { getActiveCljsRuntime } from "./cljs-runtime.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";
import type { KeyPool } from "./key-pool.js";
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

const PROVIDER_STRATEGY_INFOS = allProviderStrategyInfos();
const UPSTREAM_MODES = PROVIDER_STRATEGY_INFOS.map((strategy) => strategy.mode);

const DEFAULT_MANIFEST = "resources/policies/runtime/00-manifest.edn";

export const providerRoutesFromRaw = (rawRoutes: unknown): ProviderRoute[] | undefined =>
  kernels.providerRoutesFromRaw(rawRoutes) as ProviderRoute[] | undefined;

type ProviderRouteRuntimeConfig = Pick<ProxyConfig, "cljsPolicyManifestPath" | "openaiProviderId" | "openaiBaseUrl" | "upstreamProviderBaseUrls"> & Partial<Pick<ProxyConfig, "ollamaBaseUrl">>;

export function getDeclaredProviderRoutes(configOrManifestPath?: ProviderRouteRuntimeConfig | string): ProviderRoute[] {
  const config = typeof configOrManifestPath === "object" ? configOrManifestPath : undefined;
  const manifestPath = typeof configOrManifestPath === "string" ? configOrManifestPath : configOrManifestPath?.cljsPolicyManifestPath;
  const resolvedManifest = manifestPath ?? DEFAULT_MANIFEST;
  const result = getActiveCljsRuntime()?.getProviderRoutes?.(resolvedManifest);
  return kernels.declaredProviderRoutes(policyManifestPath(), result, config) as ProviderRoute[];
}

export function filterDeclaredProviderRoutes(manifestPath: string | undefined, input: {
  readonly modelId: string;
  readonly requestKind: string;
  readonly requestedProviderIds?: readonly string[];
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

  const resolvedManifest = manifestPath ?? DEFAULT_MANIFEST;
  const result = runtime.filterProviderRoutes(resolvedManifest, input);
  if (result.status !== "ok") {
    return { providerRoutes: [...input.providerRoutes] };
  }

  const filteredRoutes = kernels.filteredProviderRoutes(result, input.providerRoutes) as ProviderRoute[];
  const preview = runtime.previewPolicyDecision(resolvedManifest, {
    modelId: input.modelId,
    requestKind: input.requestKind,
    tenantSettings: input.tenantSettings,
    providerIds: filteredRoutes.map((route) => route.providerId),
    ...(input.requestedProviderIds ? { requestedProviderIds: input.requestedProviderIds } : {}),
    strategies: PROVIDER_STRATEGY_INFOS,
  });
  const decided = kernels.applyProviderRouteDecision(preview, filteredRoutes, UPSTREAM_MODES);

  return {
    providerRoutes: decided.providerRoutes as ProviderRoute[],
    ...(decided.strategyMode ? { strategyMode: decided.strategyMode as UpstreamMode } : {}),
    ...(decided.strategyModeByProvider
      ? { strategyModeByProvider: decided.strategyModeByProvider as Readonly<Record<string, UpstreamMode>> }
      : {}),
    catalog: result.catalog,
  };
}

export const looksLikeHostedOpenAiFamily = (model: string): boolean =>
  kernels.looksLikeHostedOpenAiFamily(policyManifestPath(), model);

export const stripModelPrefix = (model: string, prefixes: readonly string[]): string =>
  kernels.stripModelPrefix(model, prefixes);

export const hasModelPrefix = (model: string, prefixes: readonly string[]): boolean =>
  kernels.hasModelPrefix(model, prefixes);

export const shouldUseLocalOllama = (model: string, patterns: readonly string[]): boolean =>
  kernels.shouldUseLocalOllama(policyManifestPath(), model, patterns);

export const resolveRequestRoutingState = (config: ProxyConfig, requestedModel: string): RequestRoutingState =>
  kernels.resolveRequestRoutingState(policyManifestPath(), config, requestedModel);

export const dedupeModelIds = (modelIds: readonly string[]): string[] => kernels.dedupeModelIds(modelIds);

export const parseModelIdsFromCatalogPayload = (payload: unknown): string[] =>
  kernels.parseModelIdsFromCatalogPayload(payload);

export const buildLargestModelAliases = (modelIds: readonly string[]): Record<string, string> =>
  kernels.buildLargestModelAliases(modelIds);

export type DynamicProviderBaseUrlGetter = (providerId: string) => Promise<string | null | undefined>;

export const createDynamicProviderBaseUrlGetter = (
  sqlCredentialStore: { getProviderById: (providerId: string) => Promise<{ baseUrl: string | null } | null> } | undefined,
): DynamicProviderBaseUrlGetter | undefined => kernels.createDynamicProviderBaseUrlGetter(sqlCredentialStore);

export const minMsUntilAnyProviderKeyReady = (keyPool: KeyPool, routes: readonly ProviderRoute[]): Promise<number> =>
  kernels.minMsUntilAnyProviderKeyReady(keyPool, routes);

export const buildOllamaCatalogRoutes = (config: ProxyConfig): ProviderRoute[] =>
  kernels.buildOllamaCatalogRoutes(policyManifestPath(), config) as ProviderRoute[];

export const providerSupportsResponsesApi = (providerId: string, openAiProviderId?: string): boolean =>
  kernels.providerSupportsResponsesApi(policyManifestPath(), providerId, openAiProviderId);

export const filterResponsesApiRoutes = (routes: readonly ProviderRoute[], openAiProviderId?: string): ProviderRoute[] =>
  kernels.filterResponsesApiRoutes(policyManifestPath(), routes, openAiProviderId);

export const providerSupportsImagesApi = (providerId: string, openAiProviderId?: string): boolean =>
  kernels.providerSupportsImagesApi(policyManifestPath(), providerId, openAiProviderId);

export const filterImagesApiRoutes = (routes: readonly ProviderRoute[], openAiProviderId?: string): ProviderRoute[] =>
  kernels.filterImagesApiRoutes(policyManifestPath(), routes, openAiProviderId);
