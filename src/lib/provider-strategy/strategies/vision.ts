import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderFallbackExecutionResult } from "../shared.js";

/**
 * Vision model fallback chain.
 *
 * Priority order:
 * 1. glm-5v-turbo - z.ai vision flagship via rotussy
 * 2. Kimi-K2.5 - ollama-cloud fallback
 * 3. gpt-5.4-mini - cloud fallback
 * 4. qwen3.5:4b-q8_0 - local ollama last resort
 */
const VISION_MODEL_CHAIN: readonly string[] = [
  "glm-5v-turbo",
  "Kimi-K2.5",
  "gpt-5.4-mini",
  "qwen3.5:4b-q8_0",
];

function normalizeModel(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function isVisionAutoModel(model: string): boolean {
  const normalized = normalizeModel(model);
  return normalized === "auto:vision";
}

/**
 * Build candidate model list for auto:vision requests.
 * Returns the configured fallback chain in order, filtered by catalog availability when possible.
 */
export function buildVisionModelCandidates(input: {
  readonly routingModelInput: string;
  readonly requestBody: unknown;
  readonly catalog: ResolvedModelCatalog | null;
  readonly availableModels?: readonly string[];
  readonly excludeDynamicOllama?: boolean;
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  if (!isVisionAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  const dynamicOllamaModelIds = input.excludeDynamicOllama !== false && input.catalog?.dynamicOllamaModelIds
    ? input.catalog.dynamicOllamaModelIds
    : undefined;

  const availableSet = new Set(
    [
      ...(input.availableModels ?? input.catalog?.modelIds ?? []),
      ...(dynamicOllamaModelIds ?? []),
    ].map(normalizeModel),
  );

  const preferredAvailable = VISION_MODEL_CHAIN.filter((modelId) => availableSet.has(normalizeModel(modelId)));
  if (preferredAvailable.length > 0) {
    return preferredAvailable;
  }

  return [...VISION_MODEL_CHAIN];
}

/**
 * Check if we should advance to the next model candidate.
 * For auto:vision, we advance on rate limits, server errors, and model-not-found.
 */
export function shouldAdvanceVisionModelCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreModelCandidates: boolean;
  readonly execution: ProviderFallbackExecutionResult;
}): boolean {
  if (!input.hasMoreModelCandidates || !isVisionAutoModel(input.routingModelInput)) {
    return false;
  }

  const { summary } = input.execution;
  return summary.sawRateLimit
    || summary.sawRequestError
    || summary.sawUpstreamServerError
    || summary.sawModelNotFound
    || summary.sawModelNotSupportedForAccount;
}

/**
 * Reorder provider routes for vision requests.
 * Prioritizes rotussy (z.ai gateway) when the model is a GLM vision model.
 * For ollama models, prioritizes ollama-cloud then local ollama.
 */
export function reorderVisionProviderRoutes(
  routes: readonly { readonly providerId: string; readonly baseUrl: string }[],
  routedModel: string,
): { readonly providerId: string; readonly baseUrl: string }[] {
  const normalized = normalizeModel(routedModel);

  // For GLM vision models, prioritize rotussy (z.ai gateway)
  if (normalized === "glm-5v-turbo" || normalized === "glm-4.6v" || normalized === "glm-4.5v") {
    const rotussyRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];
    const otherRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];

    for (const route of routes) {
      if (route.providerId === "rotussy") {
        rotussyRoutes.push(route);
      } else {
        otherRoutes.push(route);
      }
    }

    return [...rotussyRoutes, ...otherRoutes];
  }

  // For Kimi-K2.5, prioritize ollama-cloud
  if (normalized === "kimi-k2.5" || normalized === "kimi") {
    const ollamaCloudRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];
    const otherRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];

    for (const route of routes) {
      if (route.providerId === "ollama-cloud") {
        ollamaCloudRoutes.push(route);
      } else {
        otherRoutes.push(route);
      }
    }

    return [...ollamaCloudRoutes, ...otherRoutes];
  }

  // For ollama/local models, prioritize ollama providers
  if (normalized.startsWith("qwen") || normalized.includes(":")) {
    const ollamaRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];
    const otherRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];

    for (const route of routes) {
      if (route.providerId.startsWith("ollama")) {
        ollamaRoutes.push(route);
      } else {
        otherRoutes.push(route);
      }
    }

    return [...ollamaRoutes, ...otherRoutes];
  }

  return [...routes];
}

export const VISION_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:vision",
];
