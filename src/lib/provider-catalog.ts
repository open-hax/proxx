import type { ProxyConfig } from "./config.js";
import type { KeyPool } from "./key-pool.js";
import type { ProviderRoute, ResolvedModelCatalog } from "./provider-routing.js";
import { fetchWithResponseTimeout, joinUrl } from "./http/index.js";
import type { ModelPreferences } from "./models.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

export interface ProviderCatalogEntry {
  readonly providerId: string;
  readonly modelIds: readonly string[];
  readonly fetchedAt: number;
  readonly stale: boolean;
  readonly sourceEndpoints: readonly string[];
}

export interface ResolvedCatalogWithPreferences {
  readonly catalog: ResolvedModelCatalog;
  readonly providerCatalogs: Readonly<Record<string, ProviderCatalogEntry>>;
  readonly preferences: ModelPreferences;
}

/**
 * Resolved model catalog of every provider route. The store itself (cache, per-route
 * fetch with key-pool credentials and timeouts, catalog assembly) is the CLJS
 * runtime's `proxx.runtime.catalog`; the HTTP helpers it cannot import are handed in.
 */
export class ProviderCatalogStore {
  private readonly impl: ReturnType<typeof kernels.createProviderCatalogStore>;

  constructor(
    config: ProxyConfig,
    keyPool: KeyPool,
    routes: readonly ProviderRoute[],
    ollamaRoutes: readonly ProviderRoute[],
  ) {
    this.impl = kernels.createProviderCatalogStore(policyManifestPath(), config, keyPool, routes, ollamaRoutes, {
      fetchWithResponseTimeout,
      joinUrl,
    });
  }

  public getCatalog(forceRefresh = false): Promise<ResolvedCatalogWithPreferences> {
    return this.impl.getCatalog(forceRefresh) as Promise<ResolvedCatalogWithPreferences>;
  }

  public isModelAvailable(providerId: string, modelId: string): Promise<boolean> {
    return this.impl.isModelAvailable(providerId, modelId);
  }
}
