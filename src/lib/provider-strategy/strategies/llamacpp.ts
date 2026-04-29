import {
  ChatCompletionsProviderStrategy,
} from "./standard.js";
import {
  buildPayloadResult,
  buildRequestBodyForUpstream,
  ensureChatCompletionsUsageInStream,
  type BuildPayloadResult,
  type StrategyRequestContext,
} from "../shared.js";

/**
 * Normalizes a model name for llama.cpp: colons become hyphens.
 *
 * Ollama-style model names like "gemma4:e4b" or "qwen3.5:4b" use colons
 * as delimiters, but llama.cpp model aliases use hyphens (e.g. "gemma4-e4b").
 * This normalization bridges the gap so that proxx catalog names (which may
 * use Ollama conventions) resolve correctly when forwarded to a llama.cpp server.
 */
export function normalizeLlamacppModelName(model: string): string {
  return model.replace(/:/g, "-");
}

/**
 * Provider strategy for llama.cpp server endpoints.
 *
 * Behaves like ChatCompletionsProviderStrategy but normalizes model names
 * (colon → hyphen) to match llama.cpp's `--alias` convention.
 */
export class LlamacppChatCompletionsProviderStrategy extends ChatCompletionsProviderStrategy {
  public override matches(context: StrategyRequestContext): boolean {
    return context.routeProviderId === "llamacpp"
      && context.responsesPassthrough !== true
      && context.imagesPassthrough !== true;
  }

  public override buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    // Normalize the model name for llama.cpp (e.g. "gemma4:e4b" → "gemma4-e4b")
    if (typeof upstreamPayload.model === "string") {
      upstreamPayload.model = normalizeLlamacppModelName(upstreamPayload.model);
    }
    ensureChatCompletionsUsageInStream(upstreamPayload);
    return buildPayloadResult(upstreamPayload, context);
  }
}
