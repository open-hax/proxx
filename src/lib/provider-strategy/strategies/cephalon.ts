import { isAutoModel, rankAutoModels, selectAutoModel } from "../../auto-model-selector.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { ResolvedModelCatalog } from "../../provider-routing.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { ProviderFallbackExecutionResult } from "../shared.js";

const CEPHALON_PROVIDER_ORDER: readonly string[] = [
  "ollama-cloud",
  "requesty",
  "zen",
  "openai",
  "ollama-stealth",
  "ollama-big-ussy",
];

const CEPHALON_PREFERRED_MODELS: readonly string[] = [
  "gpt-5.4-nano",
  "gpt-5.3-nano",
  "gpt-5.2-nano",
  "gpt-5.1-nano",
  "gpt-5-nano",
  "gpt-5.4-mini",
  "gpt-5.3-mini",
  "gpt-5.2-mini",
  "gpt-5.1-mini",
  "gpt-5-mini",
  "glm-4-flash",
  "glm-4.7",
  "qwen3.5:0.6b",
  "qwen3.5:1.5b",
  "qwen3.5:2b",
  "qwen3.5:4b",
];

const CEPHALON_OLLAMA_PREFERRED: readonly string[] = [
  "gpt-oss:20b",
  "gpt-oss:120b",
  "qwen3-coder:480b",
  "gemma3:27b",
  "gemma3:12b",
  "gemma3:4b",
];

const CEPHALON_OLLAMA_FAST_ORDER: readonly string[] = [
  "gpt-oss:20b",
  "gemma3:12b",
  "gemma3:4b",
  "gemma3:27b",
  "gpt-oss:120b",
  "qwen3-coder:480b",
];

const CEPHALON_OLLAMA_SMART_ORDER: readonly string[] = [
  "gpt-oss:120b",
  "qwen3-coder:480b",
  "gemma3:27b",
  "gpt-oss:20b",
  "gemma3:12b",
  "gemma3:4b",
];

function preferOrderedModel(
  ranked: readonly { readonly modelId: string }[],
  preferredOrder: readonly string[],
): string | null {
  const rankedSet = new Set(ranked.map((entry) => normalizeModel(entry.modelId)));

  for (const modelId of preferredOrder) {
    if (rankedSet.has(normalizeModel(modelId))) {
      return modelId;
    }
  }

  return null;
}

function normalizeModel(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function isOllamaProvider(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "ollama-cloud"
    || normalized.startsWith("ollama-")
    || normalized === "local-ollama";
}

export function isCephalonAutoModel(model: string): boolean {
  const normalized = normalizeModel(model);
  return normalized === "auto:cephalon" || normalized.startsWith("auto:cephalon:");
}

export function resolveCephalonAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
  dynamicOllamaModelIds?: readonly string[],
): string | null {
  if (!isCephalonAutoModel(model)) {
    return null;
  }

  const suffix = model.includes(":")
    ? model.split(":").slice(1).join(":").trim().toLowerCase()
    : "cheapest";

  const autoType = suffix === "fastest"
    ? "fastest"
    : suffix === "smartest"
      ? "smartest"
      : "cheapest";

  const innerAutoModel = `auto:${autoType}`;

  const preferredOllamaSet = new Set(CEPHALON_OLLAMA_PREFERRED.map(normalizeModel));
  const dynamicOllamaSet = new Set((dynamicOllamaModelIds ?? []).map(normalizeModel));

  const allAvailableModels = [...new Set([
    ...(availableModels ?? []),
    ...CEPHALON_OLLAMA_PREFERRED,
    ...(dynamicOllamaModelIds ?? []),
  ])];

  const ranked = rankAutoModels(
    innerAutoModel,
    requestBody,
    allAvailableModels,
    providerId,
    requestLogStore,
    accountHealthStore,
  );

  if (ranked.length === 0) {
    return CEPHALON_PREFERRED_MODELS[0] ?? "gpt-5-nano";
  }

  const preferredSet = new Set(CEPHALON_PREFERRED_MODELS.map(normalizeModel));
  const orderedOllamaChoice = preferOrderedModel(
    ranked,
    autoType === "smartest" ? CEPHALON_OLLAMA_SMART_ORDER : CEPHALON_OLLAMA_FAST_ORDER,
  );

  if (orderedOllamaChoice) {
    return orderedOllamaChoice;
  }

  const preferredOllama = ranked.find((entry) => preferredOllamaSet.has(normalizeModel(entry.modelId)));

  if (preferredOllama) {
    return preferredOllama.modelId;
  }

  const otherDynamicOllama = ranked.find((entry) => dynamicOllamaSet.has(normalizeModel(entry.modelId)));

  if (otherDynamicOllama) {
    return otherDynamicOllama.modelId;
  }

  const inPreferred = ranked.find((entry) => preferredSet.has(normalizeModel(entry.modelId)));

  return inPreferred?.modelId ?? ranked[0]?.modelId ?? "gpt-5-nano";
}

export function buildCephalonModelCandidates(input: {
  readonly routingModelInput: string;
  readonly requestBody: unknown;
  readonly catalog: ResolvedModelCatalog | null;
  readonly availableModels?: readonly string[];
  readonly excludeDynamicOllama?: boolean;
  readonly providerId: string;
  readonly requestLogStore?: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}): string[] {
  if (!isCephalonAutoModel(input.routingModelInput)) {
    return [input.routingModelInput];
  }

  const dynamicOllamaModelIds = input.excludeDynamicOllama !== false && input.catalog?.dynamicOllamaModelIds
    ? input.catalog.dynamicOllamaModelIds
    : undefined;

  const resolved = resolveCephalonAutoModel(
    input.routingModelInput,
    input.requestBody,
    input.availableModels,
    input.providerId,
    input.requestLogStore,
    input.accountHealthStore,
    dynamicOllamaModelIds,
  );

  return resolved ? [resolved] : [];
}

export function reorderCephalonProviderRoutes(
  routes: readonly { readonly providerId: string; readonly baseUrl: string }[],
  dynamicOllamaProviders?: readonly { readonly providerId: string; readonly baseUrl: string }[],
): { readonly providerId: string; readonly baseUrl: string }[] {
  const cephalonIndex = new Map<string, number>(
    CEPHALON_PROVIDER_ORDER.map((providerId, index) => [providerId, index] as const),
  );

  const ollamaRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];
  const cephalonRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];
  const otherRoutes: { readonly providerId: string; readonly baseUrl: string }[] = [];

  const seenProviderIds = new Set<string>();

  if (dynamicOllamaProviders && dynamicOllamaProviders.length > 0) {
    for (const route of dynamicOllamaProviders) {
      if (!seenProviderIds.has(route.providerId)) {
        ollamaRoutes.push(route);
        seenProviderIds.add(route.providerId);
      }
    }
  }

  for (const providerId of CEPHALON_PROVIDER_ORDER) {
    const matchingRoute = routes.find((route) => route.providerId === providerId);
    if (matchingRoute && !seenProviderIds.has(matchingRoute.providerId)) {
      cephalonRoutes.push(matchingRoute);
      seenProviderIds.add(matchingRoute.providerId);
    }
  }

  for (const route of routes) {
    if (!seenProviderIds.has(route.providerId)) {
      otherRoutes.push(route);
    }
  }

  return [...ollamaRoutes, ...cephalonRoutes, ...otherRoutes];
}

export function shouldAdvanceCephalonProviderCandidate(input: {
  readonly routingModelInput: string;
  readonly hasMoreProviderCandidates: boolean;
  readonly execution: ProviderFallbackExecutionResult;
}): boolean {
  if (!input.hasMoreProviderCandidates || !isCephalonAutoModel(input.routingModelInput)) {
    return false;
  }

  const { summary } = input.execution;
  return summary.sawRateLimit
    || summary.sawRequestError
    || summary.sawUpstreamServerError
    || summary.sawModelNotFound
    || summary.sawModelNotSupportedForAccount;
}

export const CEPHALON_AUTO_MODEL_TYPES: readonly string[] = [
  "auto:cephalon",
  "auto:cephalon:cheapest",
  "auto:cephalon:fastest",
  "auto:cephalon:smartest",
];
