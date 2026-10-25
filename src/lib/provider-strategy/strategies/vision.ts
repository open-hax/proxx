import type { AccountHealthStore } from "../../db/account-health-store.js";
import { kernels } from "../../cljs-kernels.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

/*
 * The auto:vision fallback chain (glm-5v-turbo, Kimi-K2.5, gpt-5.4-mini, local qwen)
 * and its provider ordering are facts in 79-auto-model-chains.edn, interpreted by
 * proxx.strategy.chains.
 */
export function isVisionAutoModel(model: string): boolean {
  return kernels.isVisionAutoModel(model);
}

/**
 * Build candidate model list for auto:vision requests.
 * Returns the configured routing chain in order, filtered by catalog availability when possible.
 */
export function buildVisionModelCandidates(input: {
  readonly routingModelInput: string;
  readonly requestBody: unknown;
  readonly catalog: ResolvedModelCatalog | null;
  readonly availableModels?: readonly string[];
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  if (!isVisionAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  return kernels.visionModelCandidates(input.availableModels ?? input.catalog?.modelIds ?? []);
}

/**
 * Check if we should advance to the next model candidate.
 * For auto:vision, we advance on rate limits, server errors, and model-not-found.
 */
export function shouldAdvanceVisionModelCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreModelCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  return kernels.shouldAdvanceAutoCandidate(
    { hasMore: input.hasMoreModelCandidates, autoModel: isVisionAutoModel(input.routingModelInput) },
    input.execution.summary,
  );
}

/**
 * Reorder provider routes for vision requests: providers favoured for the routed
 * model (zai for GLM vision models, ollama-cloud for Kimi, ollama for local models)
 * go first.
 */
export function reorderVisionProviderRoutes(
  routes: readonly { readonly providerId: string; readonly baseUrl: string }[],
  routedModel: string,
): { readonly providerId: string; readonly baseUrl: string }[] {
  return kernels
    .visionRouteOrder(routedModel, routes.map((route) => route.providerId))
    .map((index) => routes[index]!);
}

export const VISION_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:vision",
];
