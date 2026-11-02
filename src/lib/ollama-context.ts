import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * Ollama context budgeting. The /api/show fetch with its cache is CLJS
 * (`proxx.runtime.ollama-context`), the arithmetic is pure
 * (`proxx.compat.ollama-context`); these entry points keep their signatures.
 */
export interface OllamaContextBudget {
  readonly model: string;
  readonly contextLength: number;
  readonly estimatedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly requiredContextTokens: number;
  readonly availableContextTokens: number;
  readonly recommendedNumCtx: number;
}

export function fetchOllamaModelContextLength(
  baseUrl: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  return kernels.fetchOllamaModelContextLength(policyManifestPath(), baseUrl, model, timeoutMs, signal);
}

export async function ensureOllamaContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  return (await kernels.ensureOllamaContextFits(policyManifestPath(), "chat", baseUrl, requestBody, timeoutMs, signal)) ?? null;
}

export async function ensureNativeOllamaChatContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  return (await kernels.ensureOllamaContextFits(policyManifestPath(), "nativeChat", baseUrl, requestBody, timeoutMs, signal)) ?? null;
}

export async function ensureNativeOllamaEmbedContextFits(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaContextBudget | null> {
  return (await kernels.ensureOllamaContextFits(policyManifestPath(), "embed", baseUrl, requestBody, timeoutMs, signal)) ?? null;
}
