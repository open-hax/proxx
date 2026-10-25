import {
  ChatCompletionsProviderStrategy,
} from "./standard.js";
import { kernels } from "../../cljs-kernels.js";
import {
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  strategyUpstreamPath,
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
  return kernels.normalizeLlamacppModelName(model);
}

/**
 * Provider strategy for llama.cpp server endpoints.
 *
 * Behaves like ChatCompletionsProviderStrategy but normalizes model names
 * (colon → hyphen) to match llama.cpp's `--alias` convention.
 */
export class LlamacppChatCompletionsProviderStrategy extends ChatCompletionsProviderStrategy {
  public override readonly registryId: string = "llamacpp-chat";

  public override getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("llamacpp-chat", context);
  }

  public override buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    // The model name is normalised for llama.cpp (e.g. "gemma4:e4b" → "gemma4-e4b").
    return buildStrategyPayloadResult("llamacpp-chat", context, buildRequestBodyForUpstream(context));
  }
}
