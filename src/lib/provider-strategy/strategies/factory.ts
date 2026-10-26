import {
  buildFactoryAnthropicHeaders,
  buildFactoryCommonHeaders,
  getFactoryEndpointPath,
} from "../../factory-compat.js";
import { BaseProviderStrategy, TransformedJsonProviderStrategy } from "../base.js";
import {
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type StrategyRequestContext,
} from "../shared.js";

export class FactoryResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "responses_passthrough" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "factory-responses-passthrough";

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("openai");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("factory-responses-passthrough", context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    const factoryHeaders = buildFactoryCommonHeaders(context.routedModel);
    for (const [name, value] of Object.entries(factoryHeaders)) {
      headers.set(name, value);
    }
  }
}


export class FactoryMessagesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "messages" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "factory-messages";

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("anthropic");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    // System content is sanitised, given a default max_tokens, thinking-budget
    // normalised and always inlined into the first user message (see proxx.strategy.build).
    return buildStrategyPayloadResult("factory-messages", context, buildRequestBodyForUpstream(context));
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void {
    const anthropicHeaders = buildFactoryAnthropicHeaders(
      context.routedModel,
      payload,
      context.config.messagesInterleavedThinkingBeta,
    );
    for (const [name, value] of Object.entries(anthropicHeaders)) {
      headers.set(name, value);
    }
  }
}

/**
 * Factory.ai OpenAI Responses strategy.
 *
 * Routes gpt-* models to Factory's `/api/llm/o/v1/responses` endpoint,
 * translating OpenAI chat format to Responses format and back.
 * Adds Factory-specific headers. Streaming is handled by the Responses event
 * stream translation in proxx.runtime.provider-reply.
 */
export class FactoryResponsesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "responses" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "factory-responses";

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("openai");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("factory-responses", context, buildRequestBodyForUpstream(context));
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    const factoryHeaders = buildFactoryCommonHeaders(context.routedModel);
    for (const [name, value] of Object.entries(factoryHeaders)) {
      headers.set(name, value);
    }
  }
}

/**
 * Factory.ai Common Chat Completions strategy.
 *
 * Routes non-Claude, non-GPT models (gemini, glm, kimi, DeepSeek, etc.)
 * to Factory's `/api/llm/o/v1/chat/completions` endpoint.
 * Passes through standard chat completions format with Factory-specific headers.
 */
export class FactoryChatCompletionsProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "chat_completions" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "factory-chat";

  public getUpstreamPath(_context: StrategyRequestContext): string {
    return getFactoryEndpointPath("common");
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("factory-chat", context, buildRequestBodyForUpstream(context));
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    const factoryHeaders = buildFactoryCommonHeaders(context.routedModel);
    for (const [name, value] of Object.entries(factoryHeaders)) {
      headers.set(name, value);
    }
  }
}
