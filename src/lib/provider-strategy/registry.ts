import type { ProviderStrategy, StrategyRequestContext, UpstreamMode } from "./shared.js";
import { GeminiChatProviderStrategy } from "./strategies/gemini.js";
import { FactoryChatCompletionsProviderStrategy, FactoryMessagesProviderStrategy, FactoryResponsesPassthroughStrategy, FactoryResponsesProviderStrategy } from "./strategies/factory.js";
import { OpenAiChatCompletionsProviderStrategy, OpenAiResponsesPassthroughStrategy, OpenAiResponsesProviderStrategy } from "./strategies/openai.js";
import { LocalOllamaProviderStrategy, OllamaProviderStrategy, RemoteOllamaProviderStrategy } from "./strategies/ollama.js";
import { OllamaCloudProviderStrategy } from "./strategies/ollama-cloud.js";
import { BlazeChatCompletionsProviderStrategy, BlazeImagesGenerationsPassthroughStrategy, ChatCompletionsProviderStrategy, ImagesGenerationsPassthroughStrategy, MessagesProviderStrategy, ResponsesPassthroughStrategy, ResponsesProviderStrategy, ResponsesViaChatCompletionsStrategy, ZaiChatCompletionsProviderStrategy } from "./strategies/standard.js";
import { LlamacppChatCompletionsProviderStrategy } from "./strategies/llamacpp.js";
import { HuggingFaceEmbeddingStrategy, OpenAiCompatEmbeddingsStrategy, OllamaEmbeddingsStrategy, OvmNpuEmbeddingStrategy, TEIEmbeddingStrategy } from "./strategies/embeddings.js";

export const GEMINI_CHAT_STRATEGY = new GeminiChatProviderStrategy();
export const ZAI_CHAT_STRATEGY = new ZaiChatCompletionsProviderStrategy();
export const BLAZE_CHAT_STRATEGY = new BlazeChatCompletionsProviderStrategy();
export const ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY = new ResponsesViaChatCompletionsStrategy();
export const OLLAMA_CLOUD_STRATEGY = new OllamaCloudProviderStrategy();
export const LLAMACPP_CHAT_STRATEGY = new LlamacppChatCompletionsProviderStrategy();
export const OPENAI_COMPAT_EMBEDDINGS_STRATEGY = new OpenAiCompatEmbeddingsStrategy();
export const OLLAMA_EMBEDDINGS_STRATEGY = new OllamaEmbeddingsStrategy();

export const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = [
  new HuggingFaceEmbeddingStrategy(),
  new TEIEmbeddingStrategy(),
  new OvmNpuEmbeddingStrategy(),
  new BlazeImagesGenerationsPassthroughStrategy(),
  new ImagesGenerationsPassthroughStrategy(),
  new OpenAiResponsesPassthroughStrategy(),
  new FactoryResponsesPassthroughStrategy(),
  new ResponsesPassthroughStrategy(),
  // Provider-specific adapters (policy chooses when applicable)
  GEMINI_CHAT_STRATEGY,
  ZAI_CHAT_STRATEGY,
  BLAZE_CHAT_STRATEGY,
  OPENAI_COMPAT_EMBEDDINGS_STRATEGY,
  OLLAMA_EMBEDDINGS_STRATEGY,
  LLAMACPP_CHAT_STRATEGY,
  ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY,
  OLLAMA_CLOUD_STRATEGY,
  new RemoteOllamaProviderStrategy(),
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

export function selectProviderStrategyForContext(
  context: StrategyRequestContext,
): ProviderStrategy {
  const matchingStrategies = PROVIDER_STRATEGIES.filter((entry) => entry.matches(context));
  if (matchingStrategies.length === 0) {
    return PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  return matchingStrategies[0]!;
}

export function allProviderStrategyInfos(): Array<{ readonly mode: UpstreamMode; readonly isLocal: boolean; readonly priority: number }> {
  return PROVIDER_STRATEGIES.map((strategy, index) => ({
    mode: strategy.mode,
    isLocal: strategy.isLocal,
    priority: PROVIDER_STRATEGIES.length - index,
  }));
}

export function selectRemoteProviderStrategyForRoute(
  context: StrategyRequestContext,
  providerId: string,
  policyPreferredStrategyMode?: UpstreamMode,
): ProviderStrategy {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const effectivePolicyPreferredStrategyMode = policyPreferredStrategyMode
    ?? context.policyPreferredStrategyModeByProvider?.[normalizedProviderId]
    ?? context.policyPreferredStrategyMode;

  const routeContext: StrategyRequestContext = {
    ...context,
    routeProviderId: normalizedProviderId,
    openAiPrefixed: providerId === context.config.openaiProviderId,
    factoryPrefixed: providerId === "factory",
    explicitOllama: false,
    localOllama: false,
    policyPreferredStrategyMode: effectivePolicyPreferredStrategyMode,
  };

  const matchingStrategies = PROVIDER_STRATEGIES.filter((entry) => !entry.isLocal && entry.matches(routeContext));
  if (matchingStrategies.length === 0) {
    return PROVIDER_STRATEGIES[PROVIDER_STRATEGIES.length - 1]!;
  }

  if (effectivePolicyPreferredStrategyMode) {
    return matchingStrategies.find((strategy) => strategy.mode === effectivePolicyPreferredStrategyMode)
      ?? matchingStrategies[0]!;
  }

  return matchingStrategies[0]!;
}

export function selectExecutionStrategyForProviderRoutes(
  context: StrategyRequestContext,
  defaultStrategy: ProviderStrategy,
  providerIds: readonly string[],
  policyPreferredStrategyMode?: UpstreamMode,
): ProviderStrategy {
  if (providerIds.length === 0) {
    return defaultStrategy;
  }

  const normalizedProviderIds = providerIds
    .map((providerId) => providerId.trim().toLowerCase())
    .filter((providerId) => providerId.length > 0);
  if (normalizedProviderIds.length === 0) {
    return defaultStrategy;
  }

  const localOllamaOnly = normalizedProviderIds.every((providerId) => providerId === "ollama" || providerId === "ollama-local");
  if (localOllamaOnly) {
    return defaultStrategy;
  }

  return selectRemoteProviderStrategyForRoute(context, normalizedProviderIds[0]!, policyPreferredStrategyMode);
}
