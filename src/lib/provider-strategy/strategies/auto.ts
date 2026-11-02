import { kernels } from "../../cljs-kernels.js";
import { rankAutoModels, selectAutoModel } from "../../auto-model-selector.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

/*
 * Host glue only: the ranking needs the request log, account health and the
 * pricing table, so it is handed to the kernels as a callback. Whether a model is
 * `auto:*`, how many candidates it may try and when to advance are decided in CLJS
 * (proxx.runtime.strategy-routes, proxx.strategy.chains).
 */
export function resolveAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): string {
  return kernels.resolveAutoModelWith(model, (autoModel) =>
    selectAutoModel(autoModel, requestBody, availableModels, providerId, requestLogStore, accountHealthStore));
}

export function buildAutoModelCandidates(input: {
  readonly routingModelInput: string;
  readonly requestBody: unknown;
  readonly catalog: ResolvedModelCatalog | null;
  readonly availableModels?: readonly string[];
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  return kernels.autoModelCandidatesWith(input.routingModelInput, (model) =>
    rankAutoModels(
      model,
      input.requestBody,
      input.availableModels ?? input.catalog?.modelIds,
      input.providerId,
      input.requestLogStore,
      input.accountHealthStore,
    ).map((entry) => entry.modelId));
}

export function shouldAdvanceAutoModelCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreModelCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  return kernels.shouldAdvanceModelCandidate("auto", input.routingModelInput, input.hasMoreModelCandidates, input.execution.summary);
}
