import { appendCsvHeaderValue, shouldEnableInterleavedThinkingHeader } from "../../openai/index.js";
import { BaseProviderStrategy, TransformedJsonProviderStrategy } from "../base.js";
import {
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type StrategyRequestContext,
} from "../shared.js";

export class MessagesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "messages" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "messages";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("messages", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("messages", context, buildRequestBodyForUpstream(context));
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void {
    if (context.config.messagesInterleavedThinkingBeta && shouldEnableInterleavedThinkingHeader(payload)) {
      appendCsvHeaderValue(headers, "anthropic-beta", context.config.messagesInterleavedThinkingBeta);
    }
  }
}

export class ResponsesProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "responses" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "responses";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("responses", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("responses", context, buildRequestBodyForUpstream(context));
  }
}


export class ChatCompletionsProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "chat_completions" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "chat-completions";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("chat-completions", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("chat-completions", context, buildRequestBodyForUpstream(context));
  }
}

export class ZaiChatCompletionsProviderStrategy extends ChatCompletionsProviderStrategy {
  public override readonly registryId: string = "zai-chat";

  public override getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("zai-chat", context);
  }
}

export class BlazeChatCompletionsProviderStrategy extends ChatCompletionsProviderStrategy {
  public override readonly registryId: string = "blaze-chat";

  public override getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("blaze-chat", context);
  }
}

export class BlazeImagesGenerationsPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "images" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "blaze-images";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("blaze-images", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("blaze-images", context);
  }
}

export class ImagesGenerationsPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "images" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "images-passthrough";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("images-passthrough", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("images-passthrough", context);
  }
}


export class ResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "responses_passthrough" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "responses-passthrough";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("responses-passthrough", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("responses-passthrough", context, buildRequestBodyForUpstream(context));
  }
}

export class ResponsesViaChatCompletionsStrategy extends BaseProviderStrategy {
  public readonly mode = "chat_completions" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "responses-via-chat";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("responses-via-chat", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("responses-via-chat", context, buildRequestBodyForUpstream(context));
  }
}
