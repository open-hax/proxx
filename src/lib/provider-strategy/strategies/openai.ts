import { BaseProviderStrategy, TransformedJsonProviderStrategy } from "../base.js";
import {
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type StrategyRequestContext,
  type UpstreamMode,
} from "../shared.js";

abstract class OpenAiCodexResponsesStrategy extends TransformedJsonProviderStrategy {
  public abstract readonly mode: Extract<UpstreamMode, "openai_responses" | "openai_chat_completions">;

  public readonly isLocal = false;

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("openai-responses", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("openai-responses", context, buildRequestBodyForUpstream(context));
  }
}

export class OpenAiResponsesProviderStrategy extends OpenAiCodexResponsesStrategy {
  public readonly registryId: string = "openai-responses";

  public readonly mode = "openai_responses" as const;
}

export class OpenAiChatCompletionsProviderStrategy extends OpenAiCodexResponsesStrategy {
  public readonly registryId: string = "openai-chat";

  public readonly mode = "openai_chat_completions" as const;
}


export class OpenAiResponsesPassthroughStrategy extends BaseProviderStrategy {
  public readonly mode = "openai_responses_passthrough" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "openai-responses-passthrough";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("openai-responses-passthrough", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    return buildStrategyPayloadResult("openai-responses-passthrough", context, buildRequestBodyForUpstream(context));
  }
}
