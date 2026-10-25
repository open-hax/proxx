import { kernels } from "./cljs-kernels.js";
import { getModelPricing } from "./model-pricing.js";
import { policyManifestPath } from "./policy-manifest.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";

export type AutoModelType = "cheapest" | "fastest" | "smartest" | "healthiest";

export interface RequestCapabilities {
  readonly needsVision: boolean;
  readonly needsTools: boolean;
  readonly needsThinking: boolean;
  readonly needsImages: boolean;
}

export interface ModelScore {
  readonly modelId: string;
  readonly providerId: string;
  readonly score: number;
  readonly costScore: number;
  readonly speedScore: number;
  readonly intelligenceScore: number;
  readonly healthScore: number;
  readonly pricingFound: boolean;
  readonly observedSpeed: boolean;
}

export const isAutoModel = (model: string): boolean => kernels.isAutoModel(model);

export const parseAutoModelType = (model: string): AutoModelType | null =>
  (kernels.parseAutoModelType(model) ?? null) as AutoModelType | null;

/**
 * Rank candidate models for an `auto:<type>` request. Scoring weights and the
 * intelligence table are the `:auto-model-profile` policy contract; the ranking
 * itself is a pure CLJS reduction over observed pricing, latency and health.
 */
export function rankAutoModels(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): ModelScore[] {
  return kernels.rankAutoModels(
    policyManifestPath(),
    model,
    requestBody,
    availableModels,
    providerId,
    requestLogStore,
    accountHealthStore,
    getModelPricing,
  ) as ModelScore[];
}

export function selectAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): string | null {
  return kernels.selectAutoModel(
    policyManifestPath(),
    model,
    requestBody,
    availableModels,
    providerId,
    requestLogStore,
    accountHealthStore,
    getModelPricing,
  );
}
