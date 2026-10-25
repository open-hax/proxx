import { kernels } from "./cljs-kernels.js";
import { fetchWithResponseTimeout } from "./http/index.js";
import { policyManifestPath } from "./policy-manifest.js";

const contextLengthCache = new Map<string, { length: number; fetchedAt: number }>();
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface OllamaContextBudget {
  readonly model: string;
  readonly contextLength: number;
  readonly estimatedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly requiredContextTokens: number;
  readonly availableContextTokens: number;
  readonly recommendedNumCtx: number;
}

export async function fetchOllamaModelContextLength(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const cacheKey = `${baseUrl}::${model}`;
  const cached = contextLengthCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) {
    return cached.length;
  }

  let response: Awaited<ReturnType<typeof fetchWithResponseTimeout>>;
  try {
    response = await fetchWithResponseTimeout(`${baseUrl.replace(/\/+$/, "")}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model }),
      signal,
    }, timeoutMs);
  } catch {
    return cached?.length ?? null;
  }

  if (!response.ok) {
    return cached?.length ?? null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return cached?.length ?? null;
  }

  if (typeof payload !== "object" || payload === null) {
    return cached?.length ?? null;
  }

  const result = kernels.ollamaContextLengthFromShow(policyManifestPath(), payload) ?? null;
  if (result !== null) {
    contextLengthCache.set(cacheKey, { length: result, fetchedAt: Date.now() });
  }

  return result;
}

export async function ensureOllamaContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  const model = asString(requestBody["model"]);
  if (!model || model.length === 0) {
    return null;
  }

  const contextLength = await fetchOllamaModelContextLength(baseUrl, model, timeoutMs, signal);
  if (!contextLength || contextLength <= 0) {
    return null;
  }

  return kernels.ollamaContextBudget("chat", requestBody, contextLength) ?? null;
}

export async function ensureNativeOllamaChatContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  const model = asString(requestBody["model"]);
  if (!model || model.length === 0) {
    return null;
  }

  const contextLength = await fetchOllamaModelContextLength(baseUrl, model, timeoutMs, signal);
  if (!contextLength || contextLength <= 0) {
    return null;
  }

  return kernels.ollamaContextBudget("nativeChat", requestBody, contextLength) ?? null;
}

export async function ensureNativeOllamaEmbedContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  const model = asString(requestBody["model"]);
  if (!model || model.length === 0) {
    return null;
  }

  const contextLength = await fetchOllamaModelContextLength(baseUrl, model, timeoutMs, signal);
  if (!contextLength || contextLength <= 0) {
    return null;
  }

  return kernels.ollamaContextBudget("embed", requestBody, contextLength) ?? null;
}
