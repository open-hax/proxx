import { isAutoModel, rankAutoModels, selectAutoModel } from "../../auto-model-selector.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderFallbackExecutionResult } from "../shared.js";

const DEFAULT_AUTO_MODEL_MAX_CANDIDATES = 8;

function resolveAutoModelMaxCandidates(): number {
  const raw = process.env.PROXY_AUTO_MODEL_MAX_CANDIDATES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTO_MODEL_MAX_CANDIDATES;
  }
  return Math.min(parsed, 24);
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
  readonly excludeDynamicOllama?: boolean;
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  if (!isAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  const dynamicOllamaModelIds = new Set(
    (input.excludeDynamicOllama !== false ? input.catalog?.dynamicOllamaModelIds ?? [] : [])
      .map((modelId) => modelId.trim().toLowerCase()),
  );
  const filteredAvailableModels = (input.availableModels ?? input.catalog?.modelIds)?.filter((modelId) => {
    return !dynamicOllamaModelIds.has(modelId.trim().toLowerCase());
  });

  const ranked = rankAutoModels(
    input.routingModelInput,
    input.requestBody,
    filteredAvailableModels,
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
  readonly execution: ProviderFallbackExecutionResult;
}): boolean {
  if (!input.hasMoreModelCandidates || !isAutoModel(input.routingModelInput)) {
    return false;
  }

  const { summary } = input.execution;
  return summary.sawRateLimit
    || summary.sawRequestError
    || summary.sawUpstreamServerError
    || summary.sawModelNotFound
    || summary.sawModelNotSupportedForAccount;
}
