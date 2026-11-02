import { rankAutoModels } from "../../auto-model-selector.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import { kernels } from "../../cljs-kernels.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

/*
 * auto:cephalon picks among ranked candidates by preference lists declared in
 * 79-auto-model-chains.edn (proxx.strategy.chains). The ranking itself needs the
 * request log and account health, so it is a callback the kernel calls between
 * planning and choosing (proxx.runtime.strategy-routes).
 */
export function isCephalonAutoModel(model: string): boolean {
  return kernels.isCephalonAutoModel(model);
}

export function resolveCephalonAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): string | null {
  return kernels.resolveCephalonAutoModelWith(model, availableModels, (innerModel, candidates) =>
    rankAutoModels(innerModel, requestBody, candidates, providerId, requestLogStore, accountHealthStore)
      .map((entry) => entry.modelId));
}

export function buildCephalonModelCandidates(input: {
  readonly routingModelInput: string;
  readonly requestBody: unknown;
  readonly catalog: ResolvedModelCatalog | null;
  readonly availableModels?: readonly string[];
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  return kernels.cephalonModelCandidatesWith(input.routingModelInput, input.availableModels, (innerModel, candidates) =>
    rankAutoModels(innerModel, input.requestBody, candidates, input.providerId, input.requestLogStore, input.accountHealthStore)
      .map((entry) => entry.modelId));
}

export function shouldAdvanceCephalonProviderCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreProviderCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  return kernels.shouldAdvanceModelCandidate("cephalon", input.routingModelInput, input.hasMoreProviderCandidates, input.execution.summary);
}

export const CEPHALON_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:cephalon",
  "auto:cephalon:cheapest",
  "auto:cephalon:fastest",
  "auto:cephalon:smartest",
];
