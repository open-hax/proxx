import type { IncomingHttpHeaders } from "node:http";

import type { ProxyConfig } from "../config.js";
import { kernels } from "../cljs-kernels.js";
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

  const routedModel = chatSurface
    ? resolveAutoModel(
        routingState.routedModel,
        requestBody,
        undefined,
        config.upstreamProviderId,
      )
    : routingState.routedModel;
  // What the request is routed by (provider id, stream, timeout, prefixes) is derived in CLJS.
  const facts = kernels.deriveStrategyContextFacts({
    surface,
    routing: routingState,
    requestBody,
    hostedOpenAiFamily: looksLikeHostedOpenAiFamily(routedModel),
    config,
  });

  const context: StrategyRequestContext = {
    ...facts,
    config,
    clientHeaders,
    requestBody,
    requestAuth,
    requestedModelInput,
    routingModelInput,
    routedModel,
    factoryPrefixed: routingState.factoryPrefixed,
  };

  return { strategy: selectProviderStrategyForContext(context), context };
}
