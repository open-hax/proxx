/**
 * Factory.ai request compatibility. Routing facts live in the
 * `wire-profile/factory` policy contract; the logic is pure CLJS
 * (`proxx.compat.factory`).
 */
import type { ProviderCredential } from "./key-pool.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * Factory.ai model type classification — determines which Factory endpoint to use.
 */
export type FactoryModelType = "anthropic" | "openai" | "common";

export const getFactoryModelType = (model: string): FactoryModelType =>
  kernels.getFactoryModelType(policyManifestPath(), model) as FactoryModelType;

export const getFactoryApiProvider = (model: string): string =>
  kernels.getFactoryApiProvider(policyManifestPath(), model);

export const getFactoryEndpointPath = (modelType: FactoryModelType): string =>
  kernels.getFactoryEndpointPath(policyManifestPath(), modelType);

export const buildFactoryCommonHeaders = (model: string): Record<string, string> =>
  kernels.buildFactoryCommonHeaders(policyManifestPath(), model);

export const buildFactoryAnthropicHeaders = (
  model: string,
  payload: Record<string, unknown>,
  interleavedThinkingBeta?: string,
): Record<string, string> =>
  kernels.buildFactoryAnthropicHeaders(policyManifestPath(), model, payload, interleavedThinkingBeta);

export const inlineSystemPrompt = (payload: Record<string, unknown>): Record<string, unknown> =>
  kernels.inlineSystemPrompt(payload);

export const sanitizeFactorySystemPrompt = (systemText: string): string =>
  kernels.sanitizeFactorySystemPrompt(policyManifestPath(), systemText);

/** Check if a credential uses an fk- prefixed API key (Factory static key). */
export const isFkKey = (credential: ProviderCredential): boolean =>
  kernels.isFkKey(policyManifestPath(), credential);
