import type { IncomingHttpHeaders } from "node:http";

import type { ProxyConfig } from "../config.js";
import { requestWantsReasoningTrace } from "../openai/index.js";
import { looksLikeHostedOpenAiFamily, resolveRequestRoutingState } from "../provider-routing.js";
import { selectProviderStrategyForContext } from "./registry.js";
import type { ResolvedRequestAuth } from "../request-auth.js";
import type { ProviderStrategy, StrategyRequestContext } from "./shared.js";
import { resolveAutoModel } from "./strategies/auto.js";
import type { PolicyEngine } from "../policy/index.js";

export function selectProviderStrategy(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  routingModelInput: string,
  requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">,
  policy?: PolicyEngine,
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, routingModelInput);
  const clientWantsStream = requestBody.stream === true;
  const needsReasoningTrace = requestWantsReasoningTrace(requestBody);
  const upstreamAttemptTimeoutMs = clientWantsStream
    ? Math.min(config.requestTimeoutMs, config.streamBootstrapTimeoutMs)
    : config.requestTimeoutMs;

  let routedModel = routingState.routedModel;
  routedModel = resolveAutoModel(
    routedModel,
    requestBody,
    undefined,
    config.upstreamProviderId,
  );

  const context: StrategyRequestContext = {
    routeProviderId: routingState.factoryPrefixed
      ? "factory"
      : routingState.openAiPrefixed
        ? config.openaiProviderId
        : routingState.explicitOllama || routingState.localOllama
          ? "ollama"
          : config.upstreamProviderId,
    config,
    clientHeaders,
    requestBody,
    requestAuth,
    requestedModelInput,
    routingModelInput,
    routedModel,
    explicitOllama: routingState.explicitOllama,
    openAiPrefixed: routingState.openAiPrefixed,
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: routingState.localOllama,
    clientWantsStream,
    needsReasoningTrace,
    upstreamAttemptTimeoutMs,
  };

  return { strategy: selectProviderStrategyForContext(context, policy), context };
}

export function buildResponsesPassthroughContext(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  routingModelInput: string,
  requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">,
  policy?: PolicyEngine,
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, routingModelInput);
  const clientWantsStream = requestBody.stream === true;
  const upstreamAttemptTimeoutMs = clientWantsStream
    ? Math.min(config.requestTimeoutMs, config.streamBootstrapTimeoutMs)
    : config.requestTimeoutMs;

  const context: StrategyRequestContext = {
    routeProviderId: routingState.factoryPrefixed
      ? "factory"
      : routingState.openAiPrefixed
        ? config.openaiProviderId
        : config.upstreamProviderId,
    config,
    clientHeaders,
    requestBody,
    requestAuth,
    requestedModelInput,
    routingModelInput,
    routedModel: routingState.routedModel,
    explicitOllama: false,
    openAiPrefixed: routingState.openAiPrefixed
      || (!routingState.factoryPrefixed
        && config.upstreamProviderId === config.openaiProviderId
        && looksLikeHostedOpenAiFamily(routingState.routedModel)),
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: false,
    clientWantsStream,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs,
    responsesPassthrough: true,
  };

  return { strategy: selectProviderStrategyForContext(context, policy), context };
}

export function buildImagesPassthroughContext(
  config: ProxyConfig,
  clientHeaders: IncomingHttpHeaders,
  requestBody: Record<string, unknown>,
  model: string,
  requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">,
  policy?: PolicyEngine,
): {
  readonly strategy: ProviderStrategy;
  readonly context: StrategyRequestContext;
} {
  const routingState = resolveRequestRoutingState(config, model);

  const context: StrategyRequestContext = {
    routeProviderId: routingState.factoryPrefixed
      ? "factory"
      : routingState.openAiPrefixed
        ? config.openaiProviderId
        : config.upstreamProviderId,
    config,
    clientHeaders,
    requestBody,
    requestAuth,
    requestedModelInput: model,
    routingModelInput: model,
    routedModel: routingState.routedModel,
    explicitOllama: false,
    openAiPrefixed: routingState.openAiPrefixed,
    factoryPrefixed: routingState.factoryPrefixed,
    localOllama: false,
    clientWantsStream: false,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: config.requestTimeoutMs,
    imagesPassthrough: true,
  };

  return { strategy: selectProviderStrategyForContext(context, policy), context };
}
