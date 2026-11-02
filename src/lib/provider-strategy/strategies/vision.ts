import type { AccountHealthStore } from "../../db/account-health-store.js";
import { kernels } from "../../cljs-kernels.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

/*
 * The auto:vision fallback chain (glm-5v-turbo, Kimi-K2.5, gpt-5.4-mini, local qwen)
 * and its provider ordering are facts in 79-auto-model-chains.edn, interpreted by
 * proxx.strategy.chains; the kernels (proxx.runtime.strategy-routes) do the work.
 */
export function isVisionAutoModel(model: string): boolean {
  return kernels.isVisionAutoModel(model);
}

/**
 * Candidate models for auto:vision requests: the configured chain in order,
 * filtered by catalog availability when possible; any other model is itself.
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
  return kernels.visionModelCandidatesFor(input.routingModelInput, input.availableModels ?? input.catalog?.modelIds ?? []);
}

/** Advance on rate limits, server errors and model-not-found (the chain's `advance-on`). */
export function shouldAdvanceVisionModelCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreModelCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  return kernels.shouldAdvanceModelCandidate("vision", input.routingModelInput, input.hasMoreModelCandidates, input.execution.summary);
}

/**
 * Provider routes for vision requests: providers favoured for the routed model
 * (zai for GLM vision models, ollama-cloud for Kimi, ollama for local models) first.
 */
export function reorderVisionProviderRoutes(
  routes: readonly { readonly providerId: string; readonly baseUrl: string }[],
  routedModel: string,
): { readonly providerId: string; readonly baseUrl: string }[] {
  return kernels.reorderVisionProviderRoutes(routes, routedModel);
}

export const VISION_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:vision",
];
