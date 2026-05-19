import type { IncomingHttpHeaders } from "node:http";

import type { ProxyConfig } from "../config.js";
import { requestWantsReasoningTrace } from "../openai/index.js";
import { looksLikeHostedOpenAiFamily, resolveRequestRoutingState } from "../provider-routing.js";
import { selectProviderStrategyForContext } from "./registry.js";
import type { ResolvedRequestAuth } from "../request-auth.js";
import type { ProviderStrategy, StrategyRequestContext } from "./shared.js";
import { resolveAutoModel } from "./strategies/auto.js";
type RequestSurface = "chat" | "responses-passthrough" | "images-passthrough";

export function selectProviderStrategy(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  routingModelInput: string,
  requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">,
  options?: { readonly surface?: RequestSurface },
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, routingModelInput);
  const surface = options?.surface ?? "chat";
  const chatSurface = surface === "chat";
  const responsesPassthrough = surface === "responses-passthrough";
  const imagesPassthrough = surface === "images-passthrough";
  const clientWantsStream = imagesPassthrough ? false : requestBody.stream === true;
  const needsReasoningTrace = chatSurface ? requestWantsReasoningTrace(requestBody) : false;
  const upstreamAttemptTimeoutMs = clientWantsStream
    ? Math.min(config.requestTimeoutMs, config.streamBootstrapTimeoutMs)
    : config.requestTimeoutMs;

  const routedModel = chatSurface
    ? resolveAutoModel(
        routingState.routedModel,
        requestBody,
        undefined,
        config.upstreamProviderId,
      )
    : routingState.routedModel;
  const routeProviderId = routingState.factoryPrefixed
    ? "factory"
    : routingState.openAiPrefixed
      ? config.openaiProviderId
      : chatSurface && (routingState.explicitOllama || routingState.localOllama)
        ? "ollama"
        : config.upstreamProviderId;

  const context: StrategyRequestContext = {
    routeProviderId,
    config,
    clientHeaders,
    requestBody,
    requestAuth,
    requestedModelInput,
    routingModelInput,
    routedModel,
    explicitOllama: chatSurface ? routingState.explicitOllama : false,
    openAiPrefixed: responsesPassthrough
      ? routingState.openAiPrefixed
        || (!routingState.factoryPrefixed
          && config.upstreamProviderId === config.openaiProviderId
          && looksLikeHostedOpenAiFamily(routedModel))
      : routingState.openAiPrefixed,
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: chatSurface ? routingState.localOllama : false,
    clientWantsStream,
    needsReasoningTrace,
    upstreamAttemptTimeoutMs,
    responsesPassthrough,
    imagesPassthrough,
  };

  return { strategy: selectProviderStrategyForContext(context), context };
}
