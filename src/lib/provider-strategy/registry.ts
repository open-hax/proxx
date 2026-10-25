import { kernels } from "../cljs-kernels.js";
import { selectionFacts, type ProviderStrategy, type StrategyRequestContext, type UpstreamMode } from "./shared.js";
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

/**
 * Strategy implementations by registry id. Which one handles a request, and in
 * which priority order, is declared in 78-strategy-registry.edn and decided by
 * proxx.strategy.select; this table only maps ids to their classes.
 */
const STRATEGIES_BY_ID: Readonly<Record<string, ProviderStrategy>> = {
  "hf-embeddings": new HuggingFaceEmbeddingStrategy(),
  "tei-embeddings": new TEIEmbeddingStrategy(),
  "ovm-embeddings": new OvmNpuEmbeddingStrategy(),
  "blaze-images": new BlazeImagesGenerationsPassthroughStrategy(),
  "images-passthrough": new ImagesGenerationsPassthroughStrategy(),
  "openai-responses-passthrough": new OpenAiResponsesPassthroughStrategy(),
  "factory-responses-passthrough": new FactoryResponsesPassthroughStrategy(),
  "responses-passthrough": new ResponsesPassthroughStrategy(),
  "gemini-chat": GEMINI_CHAT_STRATEGY,
  "zai-chat": ZAI_CHAT_STRATEGY,
  "blaze-chat": BLAZE_CHAT_STRATEGY,
  "openai-compat-embeddings": OPENAI_COMPAT_EMBEDDINGS_STRATEGY,
  "ollama-embeddings": OLLAMA_EMBEDDINGS_STRATEGY,
  "llamacpp-chat": LLAMACPP_CHAT_STRATEGY,
  "responses-via-chat": ROTUSSY_RESPONSES_VIA_CHAT_STRATEGY,
  "ollama-cloud": OLLAMA_CLOUD_STRATEGY,
  "remote-ollama": new RemoteOllamaProviderStrategy(),
  "ollama": new OllamaProviderStrategy(),
  "local-ollama": new LocalOllamaProviderStrategy(),
  "factory-messages": new FactoryMessagesProviderStrategy(),
  "factory-responses": new FactoryResponsesProviderStrategy(),
  "factory-chat": new FactoryChatCompletionsProviderStrategy(),
  "openai-responses": new OpenAiResponsesProviderStrategy(),
  "openai-chat": new OpenAiChatCompletionsProviderStrategy(),
  "messages": new MessagesProviderStrategy(),
  "responses": new ResponsesProviderStrategy(),
  "chat-completions": new ChatCompletionsProviderStrategy(),
};

/** Priority order (highest first), the registry's own order. */
export const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = Object.values(STRATEGIES_BY_ID);

function strategyForId(id: string): ProviderStrategy {
  const strategy = STRATEGIES_BY_ID[id];
  if (!strategy) {
    throw new Error(`Strategy registry names unknown strategy '${id}'`);
  }
  return strategy;
}

export function selectProviderStrategyForContext(
  context: StrategyRequestContext,
): ProviderStrategy {
  return strategyForId(kernels.selectStrategy(selectionFacts(context), {}, context.config.cljsPolicyManifestPath));
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
  const facts = {
    ...selectionFacts({ ...context, routeProviderId: providerId.trim().toLowerCase() }),
    factoryModelType: providerId === "factory" ? kernels.getFactoryModelType(context.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", context.routedModel) : undefined,
  };
  return strategyForId(kernels.selectRemoteStrategy(
    facts,
    providerId,
    context.config.openaiProviderId,
    policyPreferredStrategyMode,
    context.policyPreferredStrategyModeByProvider,
    context.config.cljsPolicyManifestPath,
  ));
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
