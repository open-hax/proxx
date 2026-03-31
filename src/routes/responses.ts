import type { FastifyInstance, FastifyReply } from "fastify";

import {
  extractPromptCacheKey,
  summarizeResponsesRequestBody,
  hashPromptCacheKey,
  copyInjectedResponseHeaders,
} from "../lib/request-utils.js";
import { isRecord } from "../lib/provider-utils.js";
import {
  resolvableConcreteModelIds,
  resolvableConcreteModelIdsForProviders,
  filterProviderRoutesByModelSupport,
  shouldRejectModelFromProviderCatalog,
} from "../lib/model-routing-helpers.js";
import {
  tenantModelAllowed,
  filterTenantProviderRoutes,
  resolveExplicitTenantProviderId,
} from "../lib/tenant-policy-helpers.js";
import {
  buildResponsesPassthroughContext,
  executeProviderFallback,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";
import {
  buildProviderRoutesWithDynamicBaseUrls,
  filterResponsesApiRoutes,
  minMsUntilAnyProviderKeyReady,
  type ProviderRoute,
} from "../lib/provider-routing.js";
import { discoverDynamicOllamaRoutes, prependDynamicOllamaRoutes } from "../lib/dynamic-ollama-routes.js";
import { orderProviderRoutesByPolicy } from "../lib/provider-policy.js";
import { sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";
import { isAutoModel, rankAutoModels } from "../lib/auto-model-selector.js";
import {
  chatCompletionToSse,
  chatCompletionEventStreamToResponsesEventStream,
  chatCompletionToResponsesResponse,
  responsesRequestToChatRequest,
  shouldUseResponsesUpstream,
} from "../lib/responses-compat.js";

import type { AppDeps } from "../lib/app-deps.js";
import type { ResolvedCatalogWithPreferences } from "../lib/provider-catalog.js";

function requestedModelIsExplicitOllama(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("ollama/") || normalized.startsWith("ollama:");
}

async function handleOllamaResponsesCompatibility(
  deps: AppDeps,
  requestHeaders: Record<string, unknown>,
  requestBody: Record<string, unknown>,
  requestedModelInput: string,
  reply: FastifyReply,
): Promise<void> {
  const bridgePayload = {
    ...responsesRequestToChatRequest(requestBody),
    stream: false,
  };
  const bridgeResponse = await deps.injectNativeBridge(
    "/v1/chat/completions",
    bridgePayload,
    requestHeaders,
  );

  copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);

  if (bridgeResponse.statusCode >= 400) {
    reply.code(bridgeResponse.statusCode);
    reply.send(bridgeResponse.body ?? "");
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bridgeResponse.body ?? "null");
  } catch {
    sendOpenAiError(reply, 502, "Failed to parse proxied Ollama chat completion response", "server_error", "responses_translation_failed");
    return;
  }

  if (!isRecord(parsedBody) || !Array.isArray(parsedBody["choices"])) {
    sendOpenAiError(reply, 502, "Invalid proxied Ollama chat completion response", "server_error", "responses_translation_failed");
    return;
  }

  if (requestBody["stream"] === true) {
    let translatedStream: string;
    try {
      translatedStream = chatCompletionEventStreamToResponsesEventStream(
        chatCompletionToSse(parsedBody),
        requestedModelInput,
      );
    } catch (error) {
      sendOpenAiError(reply, 502, toErrorMessage(error), "server_error", "responses_stream_translation_failed");
      return;
    }

    reply.code(200);
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");
    reply.send(translatedStream);
    return;
  }

  reply.code(200);
  reply.header("content-type", "application/json");
  reply.send(chatCompletionToResponsesResponse(parsedBody));
}

export function registerResponsesRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/responses", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? "default",
    );
    const requestBody = request.body;
    const promptCacheKey = extractPromptCacheKey(requestBody);

    app.log.info({
      responsesBody: summarizeResponsesRequestBody(requestBody),
      hasPromptCacheKey: Boolean(promptCacheKey),
      promptCacheKey: promptCacheKey ? hashPromptCacheKey(promptCacheKey) : undefined,
    }, "responses passthrough: incoming body");

    const requestedModelInput = typeof requestBody.model === "string" ? requestBody.model : "";
    if (requestedModelInput.length === 0) {
      sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
      return;
    }

    if (!tenantModelAllowed(tenantSettings, requestedModelInput)) {
      sendOpenAiError(reply, 403, `Model is disabled for this tenant: ${requestedModelInput}`, "invalid_request_error", "model_not_allowed");
      return;
    }

    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(deps.config, requestedModelInput, tenantSettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    let routingModelInput = requestedModelInput;
    let resolvedModelCatalog = null;
    let resolvedCatalogBundle: ResolvedCatalogWithPreferences | null = null;
    try {
      const catalogBundle = await deps.providerCatalogStore.getCatalog();
      resolvedCatalogBundle = catalogBundle;
      const catalog = catalogBundle.catalog;
      resolvedModelCatalog = catalog;
      const disabledModelSet = new Set(catalogBundle.preferences.disabled);
      if (disabledModelSet.has(requestedModelInput) || disabledModelSet.has(catalog.aliasTargets[requestedModelInput] ?? "")) {
        sendOpenAiError(reply, 403, `Model is disabled: ${requestedModelInput}`, "invalid_request_error", "model_disabled");
        return;
      }
      const aliasTarget = catalog.aliasTargets[requestedModelInput];
      if (typeof aliasTarget === "string" && aliasTarget.length > 0) {
        routingModelInput = aliasTarget;
        reply.header("x-open-hax-model-alias", `${requestedModelInput}->${aliasTarget}`);
      }
    } catch (error) {
      request.log.warn({ error: toErrorMessage(error) }, "failed to resolve dynamic model aliases for /v1/responses; using requested model as-is");
    }

    if (requestedModelIsExplicitOllama(requestedModelInput) || requestedModelIsExplicitOllama(routingModelInput)) {
      await handleOllamaResponsesCompatibility(
        deps,
        request.headers as Record<string, unknown>,
        requestBody,
        requestedModelIsExplicitOllama(routingModelInput) ? routingModelInput : requestedModelInput,
        reply,
      );
      return;
    }

    const autoCandidateProviderIds = filterTenantProviderRoutes(
      filterResponsesApiRoutes(await buildProviderRoutesWithDynamicBaseUrls(deps.config, false, deps.dynamicProviderBaseUrlGetter, true), deps.config.openaiProviderId),
      tenantSettings,
    ).map((route) => route.providerId);
    const concreteModelIds = isAutoModel(routingModelInput)
      ? resolvableConcreteModelIdsForProviders(
          resolvedCatalogBundle,
          autoCandidateProviderIds,
          (modelId: string) => shouldUseResponsesUpstream(modelId, deps.config.responsesModelPrefixes),
        )
      : resolvableConcreteModelIds(resolvedModelCatalog);
    const routingModelCandidates = isAutoModel(routingModelInput)
      ? rankAutoModels(
          routingModelInput,
          requestBody,
          concreteModelIds,
          deps.config.upstreamProviderId,
          deps.requestLogStore,
          deps.accountHealthStore,
        ).map((entry) => entry.modelId)
      : [routingModelInput];

    if (routingModelCandidates.length === 0) {
      sendOpenAiError(reply, 404, `Model not found: ${requestedModelInput}`, "invalid_request_error", "model_not_found");
      return;
    }

    if (isAutoModel(routingModelInput)) {
      reply.header("x-open-hax-auto-model-candidates", routingModelCandidates.slice(0, 12).join(","));
    }

    for (const [candidateIndex, candidateRoutingModel] of routingModelCandidates.entries()) {
      const hasMoreModelCandidates = candidateIndex < routingModelCandidates.length - 1;
      const { strategy, context } = buildResponsesPassthroughContext(
        deps.config,
        request.headers,
        requestBody,
        requestedModelInput,
        candidateRoutingModel,
        (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
      );
      reply.header("x-open-hax-upstream-mode", strategy.mode);
      const requestAuth = (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth;
      const federationOwnerSubject = resolveFederationOwnerSubject({
        headers: request.headers as Record<string, unknown>,
        requestAuth,
        hopCount: 0,
      });

      let providerRoutes: ProviderRoute[];
      if (context.factoryPrefixed) {
        const factoryBaseUrl = deps.config.upstreamProviderBaseUrls["factory"] ?? "https://api.factory.ai";
        providerRoutes = deps.config.disabledProviderIds.includes("factory")
          ? []
          : [{ providerId: "factory", baseUrl: factoryBaseUrl }];
      } else {
        providerRoutes = await buildProviderRoutesWithDynamicBaseUrls(deps.config, context.openAiPrefixed, deps.dynamicProviderBaseUrlGetter, true);
      }

      const dynamicOllamaRoutes = await discoverDynamicOllamaRoutes(
        deps.sqlCredentialStore,
        deps.sqlFederationStore,
        federationOwnerSubject,
      );
      if (dynamicOllamaRoutes.length > 0) {
        providerRoutes = prependDynamicOllamaRoutes(providerRoutes, dynamicOllamaRoutes);
      }

      providerRoutes = filterProviderRoutesByModelSupport(deps.config, providerRoutes, context.routedModel);
      providerRoutes = filterResponsesApiRoutes(providerRoutes, deps.config.openaiProviderId);
      providerRoutes = filterTenantProviderRoutes(providerRoutes, tenantSettings);
      providerRoutes = orderProviderRoutesByPolicy(deps.policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
        openAiPrefixed: context.openAiPrefixed,
        localOllama: false,
        explicitOllama: false,
      });

      if (providerRoutes.length === 0) {
        if (hasMoreModelCandidates) {
          continue;
        }
        sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
        return;
      }

      try {
        const catalogBundle = await deps.providerCatalogStore.getCatalog();
        const disabledSet = new Set(catalogBundle.preferences.disabled);
        if (disabledSet.has(context.routedModel)) {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 403, `Model is disabled: ${context.routedModel}`, "invalid_request_error", "model_disabled");
          return;
        }

        if (shouldRejectModelFromProviderCatalog(providerRoutes, context.routedModel, catalogBundle)) {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 404, `Model not found: ${context.routedModel}`, "invalid_request_error", "model_not_found");
          return;
        }
      } catch (error) {
        request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog for /v1/responses; continuing without gating");
      }

      let payload: ReturnType<typeof strategy.buildPayload>;
      try {
        payload = strategy.buildPayload(context);
      } catch (error) {
        if (hasMoreModelCandidates) {
          continue;
        }
        sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
        return;
      }

      for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
        await deps.ensureFreshAccounts(providerId);
      }

      const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes, promptCacheKey);
      const execution = await executeProviderFallback(
        strategy,
        reply,
        deps.requestLogStore,
        deps.promptAffinityStore,
        deps.providerRoutePheromoneStore,
        deps.keyPool,
        providerRoutes,
        context,
        payload,
        availability.prompt_cache_key,
        deps.refreshExpiredOAuthAccount,
        deps.policyEngine,
        deps.accountHealthStore,
        deps.eventStore,
        deps.quotaMonitor,
      );

      if (execution.handled) {
        return;
      }

      const federatedResponsesHandled = await deps.executeFederatedRequestFallback({
        requestHeaders: request.headers,
        requestBody,
        requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
        providerRoutes,
        upstreamPath: "/v1/responses",
        reply,
        timeoutMs: context.upstreamAttemptTimeoutMs,
      });
      if (federatedResponsesHandled) {
        return;
      }

      if (hasMoreModelCandidates) {
        continue;
      }

      if (execution.candidateCount === 0) {
        const retryInMs = await minMsUntilAnyProviderKeyReady(deps.keyPool, providerRoutes);
        if (retryInMs > 0) {
          reply.header("retry-after", Math.ceil(retryInMs / 1000));
        }

        if (!availability.sawConfiguredProvider) {
          sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration for Responses API providers", "server_error", "keys_unavailable");
          return;
        }

        sendOpenAiError(
          reply,
          429,
          "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
          "rate_limit_error",
          "all_keys_rate_limited"
        );
        return;
      }

      const { summary } = execution;

      if (summary.sawUpstreamInvalidRequest) {
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream invalid-request responses");
        sendOpenAiError(
          reply,
          400,
          "No upstream account accepted the request payload. Check model availability and request parameters.",
          "invalid_request_error",
          "upstream_rejected_request"
        );
        return;
      }

      if (summary.sawRateLimit) {
        const retryInMs = await minMsUntilAnyProviderKeyReady(deps.keyPool, providerRoutes);
        if (retryInMs > 0) {
          reply.header("retry-after", Math.ceil(retryInMs / 1000));
        }

        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream rate limits");
        sendOpenAiError(
          reply,
          429,
          "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
          "rate_limit_error",
          "no_available_key"
        );
        return;
      }

      if (summary.sawUpstreamServerError) {
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to upstream server errors");
        sendOpenAiError(
          reply,
          502,
          "Upstream returned transient server errors across all available accounts.",
          "server_error",
          "upstream_server_error"
        );
        return;
      }

      if (summary.sawModelNotFound && !summary.sawRequestError) {
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "responses passthrough: all attempts exhausted due to model-not-found responses");
        sendOpenAiError(
          reply,
          404,
          `Model not found across available Responses API providers: ${context.routedModel}`,
          "invalid_request_error",
          "model_not_found"
        );
        return;
      }

      const message = summary.sawRequestError
        ? "All upstream attempts failed due to network/transport errors."
        : "Upstream rejected the request with no successful fallback.";

      app.log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode, sawRequestError: summary.sawRequestError }, "responses passthrough: all upstream attempts exhausted");
      sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
      return;
    }

    sendOpenAiError(reply, 502, "Upstream rejected the request with no successful fallback.", "server_error", "upstream_unavailable");
  });
}
