import { rankAutoModels } from "../../auto-model-selector.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import { kernels } from "../../cljs-kernels.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

/*
 * auto:cephalon picks among ranked candidates by preference lists declared in
 * 79-auto-model-chains.edn (proxx.strategy.chains). The ranking itself needs the
 * request log and account health, so it is requested here and handed back to the
 * kernel for the choice.
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
  if (!isCephalonAutoModel(model)) {
    return null;
  }

  const plan = kernels.cephalonPlan(model, availableModels);
  const ranked = rankAutoModels(
    plan.innerModel,
    requestBody,
    plan.candidates,
    providerId,
    requestLogStore,
    accountHealthStore,
  );

  return kernels.cephalonChoice(model, ranked.map((entry) => entry.modelId));
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
  if (!isCephalonAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  const resolved = resolveCephalonAutoModel(
    input.routingModelInput,
    input.requestBody,
    input.availableModels,
    input.providerId,
    input.requestLogStore,
    input.accountHealthStore,
  );

  return resolved ? [resolved] : [];
}

export function shouldAdvanceCephalonProviderCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreProviderCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  return kernels.shouldAdvanceAutoCandidate(
    { hasMore: input.hasMoreProviderCandidates, autoModel: isCephalonAutoModel(input.routingModelInput) },
    input.execution.summary,
  );
}

export const CEPHALON_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:cephalon",
  "auto:cephalon:cheapest",
  "auto:cephalon:fastest",
  "auto:cephalon:smartest",
];
