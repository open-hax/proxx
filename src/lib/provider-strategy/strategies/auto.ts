import { isAutoModel, rankAutoModels, selectAutoModel } from "../../auto-model-selector.js";
import { kernels } from "../../cljs-kernels.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderRoutingExecutionResult } from "../shared.js";

function resolveAutoModelMaxCandidates(): number {
  return kernels.maxAutoModelCandidates(process.env.PROXY_AUTO_MODEL_MAX_CANDIDATES);
}

export function resolveAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): string {
  if (!isAutoModel(model)) {
    return model;
  }

  return selectAutoModel(
    model,
    requestBody,
    availableModels,
    providerId,
    requestLogStore,
    accountHealthStore,
  ) ?? model;
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
  if (!isAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  const ranked = rankAutoModels(
    input.routingModelInput,
    input.requestBody,
    input.availableModels ?? input.catalog?.modelIds,
    input.providerId,
    input.requestLogStore,
    input.accountHealthStore,
  ).map((entry) => entry.modelId);

  if (ranked.length === 0) {
    return [];
  }

  return ranked.slice(0, resolveAutoModelMaxCandidates());
}

export function shouldAdvanceAutoModelCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreModelCandidates: boolean;
  readonly execution: ProviderRoutingExecutionResult;
}): boolean {
  if (!input.hasMoreModelCandidates || !isAutoModel(input.routingModelInput)) {
    return false;
  }

  return kernels.shouldAdvanceAutoCandidate(
    { hasMore: input.hasMoreModelCandidates, autoModel: isAutoModel(input.routingModelInput) },
    input.execution.summary,
  );
}
