import { normalizeReasoningRequestWithCljs } from "../../cljs-runtime.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildPayloadResult,
  buildRequestBodyForUpstream,
  buildStrategyPayloadResult,
  strategyUpstreamPath,
  type BuildPayloadResult,
  type StrategyRequestContext,
} from "../shared.js";

export class LocalOllamaProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "local_ollama_chat" as const;

  public readonly isLocal: boolean = true;
  public readonly registryId: string = "local-ollama";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("local-ollama", context);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamPayload = buildRequestBodyForUpstream(context);
    return buildPayloadResult(upstreamPayload);
  }
}

export class OllamaProviderStrategy extends BaseProviderStrategy {
  public readonly mode = "ollama_chat" as const;

  public readonly isLocal: boolean = true;
  public readonly registryId: string = "ollama";

  public getUpstreamPath(context: StrategyRequestContext): string {
    return strategyUpstreamPath("ollama", context);
  }

  protected getReasoningProviderId(context: StrategyRequestContext): string {
    return context.routeProviderId ?? "ollama";
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const requestBody = normalizeReasoningRequestWithCljs({
      manifestPath: context.config.cljsPolicyManifestPath,
      requestBody: context.requestBody,
      modelId: context.routedModel,
      providerId: this.getReasoningProviderId(context),
      strategyMode: this.mode,
    });
    return buildStrategyPayloadResult("ollama", context, requestBody);
  }
}

export class RemoteOllamaProviderStrategy extends OllamaProviderStrategy {
  public override readonly isLocal = false;
  public override readonly registryId: string = "remote-ollama";

}
