/**
 * Model pricing, energy, and environmental cost estimation.
 *
 * Every decision is made in CLJS (`proxx.pricing.model`, state and refresh in
 * `proxx.runtime.pricing`). Prices come from the models.dev snapshot
 * `resources/data/models-dev-pricing.edn`; provider aliases, vendor fallbacks and
 * energy profiles are policy contracts (`16-model-pricing-resolution.edn`), and
 * pricing overrides are `:model-pricing-override` contracts (`15-…`). This module
 * keeps the stable entry points and types.
 */
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

export interface ModelPricing {
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
  readonly reasoningPer1MTokens: number;
  readonly cacheReadPer1MTokens: number;
  readonly cacheWritePer1MTokens: number;
  readonly joulesPerInputToken: number;
  readonly joulesPerOutputToken: number;
  readonly pricingFound: boolean;
  readonly pricingSource: "models.dev" | "local" | "policy" | "unpriced";
  readonly pricingProviderId?: string;
  readonly pricingModelId?: string;
}

export interface RequestCostEstimate {
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

type FetchFn = typeof fetch;

export interface ModelPricingRefreshOptions {
  readonly sourceUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly timeoutMs?: number;
}

export interface ModelPricingRefreshSchedulerOptions extends ModelPricingRefreshOptions {
  readonly intervalMs?: number;
  readonly initialRefresh?: boolean;
  readonly onRefresh?: (status: ModelPricingIndexStatus) => void;
  readonly onError?: (error: unknown) => void;
}

export interface ModelPricingRefreshHandle {
  refreshNow(): Promise<ModelPricingIndexStatus>;
  stop(): void;
}

export interface ModelPricingIndexStatus {
  readonly generatedAt: string;
  readonly sourceUrl: string;
  readonly providerCount: number;
  readonly modelCount: number;
}

export interface ModelsDevPricingSnapshot {
  readonly generatedAt: string;
  readonly sourceUrl: string;
  readonly providers: Readonly<Record<string, {
    readonly models: Readonly<Record<string, {
      readonly input?: number;
      readonly output?: number;
      readonly reasoning?: number;
      readonly cache_read?: number;
      readonly cache_write?: number;
    }>>;
  }>>;
}

// Default data center water use efficiency: ~1.8 L/kWh (scope-1 evaporative cooling average).
// Source: University of Illinois CEE, "AI's Challenging Waters" (2025).
const DC_WUE_ML_PER_KWH = Number(process.env.DC_WATER_USE_EFFICIENCY_ML_PER_KWH ?? "1800");

/** Install the `:model-pricing-override` rules loaded from policy (unusable entries are dropped). */
export function setPolicyModelPricingOverrides(overrides: unknown): void {
  kernels.setPolicyModelPricingOverrides(overrides);
}

export function getModelPricingIndexStatus(): ModelPricingIndexStatus {
  return kernels.getModelPricingIndexStatus(policyManifestPath());
}

/** The active models.dev snapshot (the bundled EDN until a refresh replaces it). */
export function getModelsDevPricingSnapshot(): ModelsDevPricingSnapshot {
  return kernels.getModelsDevPricingSnapshot(policyManifestPath());
}

export function refreshModelsDevPricingIndex(options: ModelPricingRefreshOptions = {}): Promise<ModelPricingIndexStatus> {
  return kernels.refreshModelsDevPricingIndex(policyManifestPath(), options);
}

export function startModelsDevPricingRefresh(options: ModelPricingRefreshSchedulerOptions = {}): ModelPricingRefreshHandle {
  return kernels.startModelsDevPricingRefresh(policyManifestPath(), options);
}

export function getModelPricing(providerId: string, model: string): ModelPricing {
  return kernels.getModelPricing(policyManifestPath(), providerId, model);
}

export function estimateRequestCost(
  providerId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): RequestCostEstimate {
  return kernels.estimateRequestCost(policyManifestPath(), providerId, model, promptTokens, completionTokens, DC_WUE_ML_PER_KWH);
}
