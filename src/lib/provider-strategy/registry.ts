import type { ProviderStrategy, StrategyRequestContext } from "./shared.js";
import { providerUsesOpenAiChatCompletions } from "./shared.js";
import { shouldUseResponsesUpstream } from "../responses-compat.js";
import { isGlmModel } from "../glm-compat.js";
import type { PolicyEngine } from "../policy/index.js";
import type { ModelInfo, StrategyInfo } from "../policy/schema.js";
import { GeminiChatProviderStrategy } from "./strategies/gemini.js";
import { FactoryChatCompletionsProviderStrategy, FactoryMessagesProviderStrategy, FactoryResponsesPassthroughStrategy, FactoryResponsesProviderStrategy } from "./strategies/factory.js";
import { OpenAiChatCompletionsProviderStrategy, OpenAiResponsesPassthroughStrategy, OpenAiResponsesProviderStrategy } from "./strategies/openai.js";
import { LocalOllamaProviderStrategy, OllamaProviderStrategy } from "./strategies/ollama.js";
import { OllamaCloudProviderStrategy } from "./strategies/ollama-cloud.js";
import { ChatCompletionsProviderStrategy, ImagesGenerationsPassthroughStrategy, MessagesProviderStrategy, ResponsesPassthroughStrategy, ResponsesProviderStrategy, ResponsesViaChatCompletionsStrategy, ZaiChatCompletionsProviderStrategy } from "./strategies/standard.js";

export const GEMINI_CHAT_STRATEGY = new GeminiChatProviderStrategy();
export const ZAI_CHAT_STRATEGY = new ZaiChatCompletionsProviderStrategy();
export const ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY = new ResponsesViaChatCompletionsStrategy();
export const OLLAMA_CLOUD_STRATEGY = new OllamaCloudProviderStrategy();

export const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = [
  new ImagesGenerationsPassthroughStrategy(),
  new OpenAiResponsesPassthroughStrategy(),
  new FactoryResponsesPassthroughStrategy(),
  new ResponsesPassthroughStrategy(),
  new OllamaProviderStrategy(),
  new LocalOllamaProviderStrategy(),
  new FactoryMessagesProviderStrategy(),
  new FactoryResponsesProviderStrategy(),
  new FactoryChatCompletionsProviderStrategy(),
  new OpenAiResponsesProviderStrategy(),
  new OpenAiChatCompletionsProviderStrategy(),
  new MessagesProviderStrategy(),
  new ResponsesProviderStrategy(),
  new ChatCompletionsProviderStrategy(),
];

export function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
  policy?: PolicyEngine,
): ProviderStrategy {
  const normalizedProviderId = providerId.trim().toLowerCase();

  if (normalizedProviderId === "gemini" && context.responsesPassthrough !== true && context.imagesPassthrough !== true) {
    return GEMINI_CHAT_STRATEGY;
  }

  if (normalizedProviderId === "zai" && context.responsesPassthrough !== true && context.imagesPassthrough !== true) {
    return ZAI_CHAT_STRATEGY;
  }

  if (normalizedProviderId === "rotussy" && context.responsesPassthrough === true && context.imagesPassthrough !== true) {
    return ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY;
  }

  // ollama-cloud can be routed via the OpenAI-compatible surface for most OSS models,
  // but GLM requests should use the native /api/chat endpoint for reliability.
  if (
    normalizedProviderId === "ollama-cloud"
    && context.responsesPassthrough !== true
    && context.imagesPassthrough !== true
    && isGlmModel(context.routedModel)
  ) {
    return OLLAMA_CLOUD_STRATEGY;
  }

  if (providerUsesOpenAiChatCompletions(providerId) && context.responsesPassthrough !== true && context.imagesPassthrough !== true) {
    // Models that need the Responses API (gpt-*) should use the responses
    // strategy even for requesty/openrouter -- their /v1/chat/completions
    // endpoint rejects tools+reasoning_effort for newer models.
    const needsResponses = shouldUseResponsesUpstream(context.routedModel, context.config.responsesModelPrefixes);
    if (!needsResponses) {
      return PROVIDER_STRATEGIES.find((entry) => entry.mode === "chat_completions" && entry.matches({
        ...context,
        factoryPrefixed: false,
        openAiPrefixed: false,
        explicitOllama: false,
        localOllama: false,
      })) ?? PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
    }
  }

  const routeContext: StrategyRequestContext = {
    ...context,
    openAiPrefixed: providerId === context.config.openaiProviderId,
    factoryPrefixed: providerId === "factory",
    explicitOllama: false,
    localOllama: false,
  };

  const matchingStrategies = PROVIDER_STRATEGIES.filter((entry) => !entry.isLocal && entry.matches(routeContext));
  if (matchingStrategies.length === 0) {
    return PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  // Passthrough surfaces (Responses passthrough, images generation passthrough)
  // are request-shape driven, not model-policy driven. Preserve the explicit
  // strategy ordering in PROVIDER_STRATEGIES so we don't accidentally select a
  // chat strategy just because it also matches.
  if (routeContext.responsesPassthrough === true || routeContext.imagesPassthrough === true) {
    return matchingStrategies[0]!;
  }

  if (!policy) {
    return matchingStrategies[0]!;
  }

  const modelInfo: ModelInfo = {
    requestedModel: context.requestedModelInput,
    routedModel: context.routedModel,
    isGptModel: context.routedModel.startsWith("gpt-"),
    isOpenAiPrefixed: routeContext.openAiPrefixed,
    isLocal: false,
    isOllama: false,
  };

  const strategyInfos: StrategyInfo[] = matchingStrategies.map((strategy, index) => ({
    mode: strategy.mode,
    isLocal: strategy.isLocal,
    priority: matchingStrategies.length - index,
  }));

  const selected = policy.selectStrategy(strategyInfos, normalizedProviderId, modelInfo);
  if (!selected) {
    return matchingStrategies[0]!;
  }

  return matchingStrategies.find((strategy) => strategy.mode === selected.mode)
    ?? matchingStrategies[0]!;
}
