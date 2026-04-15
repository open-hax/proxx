import type { ProviderStrategy, StrategyRequestContext } from "./shared.js";
import type { PolicyEngine } from "../policy/index.js";
import type { ModelInfo, RequestContext, StrategyInfo } from "../policy/schema.js";
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
  // Provider-specific adapters (policy chooses when applicable)
  GEMINI_CHAT_STRATEGY,
  ZAI_CHAT_STRATEGY,
  ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY,
  OLLAMA_CLOUD_STRATEGY,
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

function buildPolicyRequestContext(input: {
  readonly context: StrategyRequestContext;
  readonly openAiPrefixed: boolean;
}): { readonly model: ModelInfo; readonly request: RequestContext } {
  const { context } = input;

  const modelInfo: ModelInfo = {
    requestedModel: context.requestedModelInput,
    routedModel: context.routedModel,
    isGptModel: context.routedModel.startsWith("gpt-"),
    isOpenAiPrefixed: input.openAiPrefixed,
    isLocal: context.localOllama,
    isOllama: context.explicitOllama,
  };

  const request: RequestContext = {
    model: modelInfo,
    clientWantsStream: context.clientWantsStream,
    needsReasoningTrace: context.needsReasoningTrace,
    requestKind: context.imagesPassthrough === true
      ? "images_passthrough"
      : context.responsesPassthrough === true
        ? "responses_passthrough"
        : "chat",
  };

  return { model: modelInfo, request };
}

export function selectProviderStrategyForContext(
  context: StrategyRequestContext,
  policy?: PolicyEngine,
): ProviderStrategy {
  const providerId = (context.routeProviderId ?? context.config.upstreamProviderId).trim().toLowerCase();
  const matchingStrategies = PROVIDER_STRATEGIES.filter((entry) => entry.matches(context));
  if (matchingStrategies.length === 0) {
    return PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  if (!policy) {
    return matchingStrategies[0]!;
  }

  const { request } = buildPolicyRequestContext({
    context,
    openAiPrefixed: context.openAiPrefixed,
  });

  const strategyInfos: StrategyInfo[] = matchingStrategies.map((strategy, index) => ({
    mode: strategy.mode,
    isLocal: strategy.isLocal,
    priority: matchingStrategies.length - index,
  }));

  const selected = policy.selectStrategy(strategyInfos, providerId, request);
  if (!selected) {
    return matchingStrategies[0]!;
  }

  return matchingStrategies.find((strategy) => strategy.mode === selected.mode)
    ?? matchingStrategies[0]!;
}

export function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
  policy?: PolicyEngine,
): ProviderStrategy {
  const normalizedProviderId = providerId.trim().toLowerCase();

  const routeContext: StrategyRequestContext = {
    ...context,
    routeProviderId: normalizedProviderId,
    openAiPrefixed: providerId === context.config.openaiProviderId,
    factoryPrefixed: providerId === "factory",
    explicitOllama: false,
    localOllama: false,
  };

  const matchingStrategies = PROVIDER_STRATEGIES.filter((entry) => !entry.isLocal && entry.matches(routeContext));
  if (matchingStrategies.length === 0) {
    return PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  if (!policy) {
    return matchingStrategies[0]!;
  }

  const { request: requestContext } = buildPolicyRequestContext({
    context: routeContext,
    openAiPrefixed: routeContext.openAiPrefixed,
  });

  const strategyInfos: StrategyInfo[] = matchingStrategies.map((strategy, index) => ({
    mode: strategy.mode,
    isLocal: strategy.isLocal,
    priority: matchingStrategies.length - index,
  }));

  const selected = policy.selectStrategy(strategyInfos, normalizedProviderId, requestContext);
  if (!selected) {
    return matchingStrategies[0]!;
  }

  return matchingStrategies.find((strategy) => strategy.mode === selected.mode)
    ?? matchingStrategies[0]!;
}
