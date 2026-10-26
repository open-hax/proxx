import { normalizeReasoningRequestWithCljs } from "../../cljs-runtime.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type StrategyRequestContext,
} from "../shared.js";

/**
 * Strategy for ollama-cloud (https://ollama.com) that uses their native /api/chat endpoint
 * instead of the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Ollama-cloud serves GLM models (glm-5.1, glm-5, glm-4.7, glm-4.6) and other models
 * via their native API, which is more reliable than the OpenAI compatibility layer.
 */
export class OllamaCloudProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "ollama_chat" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "ollama-cloud";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("ollama-cloud", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const requestBody = normalizeReasoningRequestWithCljs({
      manifestPath: context.config.cljsPolicyManifestPath,
      requestBody: context.requestBody,
      modelId: context.routedModel,
      providerId: "ollama-cloud",
      strategyMode: this.mode,
    });
    return buildStrategyPayloadResult("ollama-cloud", context, requestBody);
  }
}
