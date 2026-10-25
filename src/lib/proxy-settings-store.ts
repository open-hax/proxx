import type { Sql } from "./db/index.js";
import { kernels } from "./cljs-kernels.js";

export interface ProxySettings {
  readonly fastMode: boolean;
  readonly requestsPerMinute: number | null;
  readonly allowedModels: readonly string[] | null;
  readonly allowedProviderIds: readonly string[] | null;
  readonly disabledProviderIds: readonly string[] | null;
}

/**
 * Per-tenant proxy settings. Normalization and merging are pure CLJS
 * (`proxx.settings.proxy`); `proxx.runtime.settings` owns the tenant cache and
 * the SQL `config` row / settings-file persistence.
 */
export interface ProxySettingsStoreApi {
  warmup(): Promise<void>;
  get(): ProxySettings;
  getForTenant(tenantId?: string): Promise<ProxySettings>;
  set(next: Partial<ProxySettings>): Promise<ProxySettings>;
  setForTenant(next: Partial<ProxySettings>, tenantId?: string): Promise<ProxySettings>;
}

export type ProxySettingsStore = ProxySettingsStoreApi;

/** `new ProxySettingsStore(filePath, sql?)`; a constructor returning an object yields it. */
export const ProxySettingsStore = function ProxySettingsStore(filePath: string, sql?: Sql): ProxySettingsStoreApi {
  return kernels.createProxySettingsStore(filePath, sql);
} as unknown as new (filePath: string, sql?: Sql) => ProxySettingsStoreApi;
