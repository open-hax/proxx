import type { FastifyInstance, FastifyReply } from "fastify";

import {
  copyInjectedResponseHeaders,
} from "../lib/request-utils.js";
import {
  extractPromptCacheKey,
  hashPromptCacheKey,
  summarizeResponsesRequestBody,
} from "../lib/openai/index.js";
import { isRecord, OpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import {
  resolvableConcreteModelIdsForProviders,
} from "../lib/catalog-resolution.js";
import {
  selectProviderStrategy,
  executeProviderRoutingPlan,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { executeBridgeRequestRouting } from "../lib/federation/bridge-routing.js";
import {
  filterDeclaredProviderRoutes,
  filterResponsesApiRoutes,
  getDeclaredProviderRoutes,
  type ProviderRoutesFilterResult,
  type ProviderRoute,
} from "../lib/provider-routing.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";
import {
  chatCompletionToSse,
  chatCompletionEventStreamToResponsesEventStream,
  chatCompletionToResponsesResponse,
  responsesRequestToChatRequest,
  shouldUseResponsesUpstream,
} from "../lib/responses-compat.js";

import type { AppDeps } from "../lib/app-deps.js";
import { resolveCatalogAndAlias } from "../lib/catalog-alias-resolver.js";
import type { StrategyRequestContext } from "../lib/provider-strategy/shared.js";

function requestedModelIsExplicitOllama(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("ollama/") || normalized.startsWith("ollama:");
}

function openAiRouteError(statusCode: number, message: string, type: string, code: string, meta?: Record<string, unknown>, cause?: unknown): OpenAiHttpError {
  return new OpenAiHttpError({ statusCode, message, type, code, meta, cause });
}

function applyPolicyStrategyContext(
  context: StrategyRequestContext,
  policyResult: Pick<ProviderRoutesFilterResult, "strategyMode" | "strategyModeByProvider">,
): StrategyRequestContext {
  return {
    ...context,
    ...(policyResult.strategyMode ? { policyPreferredStrategyMode: policyResult.strategyMode } : {}),
    ...(policyResult.strategyModeByProvider ? { policyPreferredStrategyModeByProvider: policyResult.strategyModeByProvider } : {}),
  };
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
  } catch (error) {
    throw openAiRouteError(502, "Failed to parse proxied Ollama chat completion response", "server_error", "responses_translation_failed", { requestedModel: requestedModelInput }, error);
  }

  if (!isRecord(parsedBody) || !Array.isArray(parsedBody["choices"])) {
    throw openAiRouteError(502, "Invalid proxied Ollama chat completion response", "server_error", "responses_translation_failed", { requestedModel: requestedModelInput });
  }

  if (requestBody["stream"] === true) {
    let translatedStream: string;
    try {
      translatedStream = chatCompletionEventStreamToResponsesEventStream(
        chatCompletionToSse(parsedBody),
        requestedModelInput,
      );
    } catch (error) {
      throw openAiRouteError(502, toErrorMessage(error), "server_error", "responses_stream_translation_failed", { requestedModel: requestedModelInput }, error);
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
      throw openAiRouteError(400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      (request.openHaxAuth?.tenantId) ?? "default",
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
      throw openAiRouteError(400, "Missing required field: model", "invalid_request_error", "missing_model");
    }

    const catalogResult = await resolveCatalogAndAlias(
      deps.providerCatalogStore,
      requestedModelInput,
      reply,
      request.log,
    );
    if (!catalogResult) {
      return;
    }
    const { routingModelInput, resolvedCatalogBundle } = catalogResult;

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

    const autoModel = routingModelInput.toLowerCase().startsWith("auto:");
    const autoCandidateProviderIds = autoModel
      ? filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
          config: deps.config,
          modelId: routingModelInput,
          requestKind: "responses-passthrough",
          tenantSettings,
          providerRoutes: filterResponsesApiRoutes(getDeclaredProviderRoutes(deps.config), deps.config.openaiProviderId),
        }).providerRoutes.map((route) => route.providerId)
      : [];
    const concreteModelIds = autoModel
      ? (resolvableConcreteModelIdsForProviders(
          resolvedCatalogBundle,
          autoCandidateProviderIds,
          (modelId: string) => shouldUseResponsesUpstream(modelId, deps.config.responsesModelPrefixes),
        ) ?? [])
      : [];
    const autoDecision = autoModel
      ? getActiveCljsRuntime()?.resolveAutoModelCandidates?.(
          deps.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
          { modelId: routingModelInput, requestBody, availableModels: concreteModelIds },
        )
      : undefined;
    const routingModelCandidates = autoModel
      ? [...(autoDecision?.status === "ok" ? (autoDecision.candidates ?? []) : concreteModelIds)]
      : [routingModelInput];

    if (routingModelCandidates.length === 0) {
      throw openAiRouteError(404, `Model not found: ${requestedModelInput}`, "invalid_request_error", "model_not_found", { requestedModel: requestedModelInput });
    }

    if (autoModel) {
      reply.header("x-open-hax-auto-model-candidates", routingModelCandidates.slice(0, 12).join(","));
    }

    for (const [candidateIndex, candidateRoutingModel] of routingModelCandidates.entries()) {
      const hasMoreModelCandidates = candidateIndex < routingModelCandidates.length - 1;
      const { strategy, context } = selectProviderStrategy(
        deps.config,
        request.headers,
        requestBody,
        requestedModelInput,
        candidateRoutingModel,
        request.openHaxAuth ?? undefined,
        { surface: "responses-passthrough" },
      );
      reply.header("x-open-hax-upstream-mode", strategy.mode);
      const requestAuth = request.openHaxAuth ?? undefined;

      let providerRoutes: ProviderRoute[];
      if (context.factoryPrefixed) {
        providerRoutes = getDeclaredProviderRoutes(deps.config).filter(
          (route) => route.providerId === "factory",
        );
      } else {
        providerRoutes = getDeclaredProviderRoutes(deps.config);
      }

      providerRoutes = filterResponsesApiRoutes(providerRoutes, deps.config.openaiProviderId);
      const policyResult = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
        config: deps.config,
        modelId: context.routedModel || context.requestedModelInput,
        requestKind: "responses-passthrough",
        tenantSettings,
        providerRoutes,
      });
      providerRoutes = policyResult.providerRoutes;
      let executionContext = applyPolicyStrategyContext(context, policyResult);

      if (providerRoutes.length === 0) {
        if (hasMoreModelCandidates) {
          continue;
        }
        throw openAiRouteError(403, "No allowed providers are available for this tenant and request.", "invalid_request_error", "provider_not_allowed", { routedModel: context.routedModel });
      }

      try {
        const catalogResult = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
          config: deps.config,
          modelId: context.routedModel || context.requestedModelInput,
          requestKind: "responses-passthrough",
          tenantSettings,
          providerRoutes,
          catalogBundle: await deps.providerCatalogStore.getCatalog(),
        });
        providerRoutes = catalogResult.providerRoutes;
        executionContext = applyPolicyStrategyContext(executionContext, catalogResult);
        if (catalogResult.catalog?.disabled) {
          if (hasMoreModelCandidates) {
            continue;
          }
          throw openAiRouteError(403, `Model is disabled: ${context.routedModel}`, "invalid_request_error", "model_disabled", { routedModel: context.routedModel });
        }
        if (catalogResult.catalog?.rejected) {
          if (hasMoreModelCandidates) {
            continue;
          }
          throw openAiRouteError(404, `Model not found: ${context.routedModel}`, "invalid_request_error", "model_not_found", { routedModel: context.routedModel });
        }
      } catch (error) {
        if (error instanceof OpenAiHttpError) {
          throw error;
        }
        request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog for /v1/responses; continuing without gating");
      }

      let payload: ReturnType<typeof strategy.buildPayload>;
      try {
        payload = strategy.buildPayload(executionContext);
      } catch (error) {
        if (hasMoreModelCandidates) {
          continue;
        }
        throw openAiRouteError(400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options", { routedModel: context.routedModel }, error);
      }

      for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
        await deps.ensureFreshAccounts(providerId);
      }

      const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes, promptCacheKey);
      let execution: Awaited<ReturnType<typeof executeProviderRoutingPlan>>;
      try {
        execution = await runCljsQueued(
          deps.config.cljsPolicyManifestPath,
          {
            "tenant-id": request.openHaxAuth?.tenantId ?? "default",
            "provider-id": providerRoutes[0]?.providerId,
            "request-kind": "responses",
          },
          async (controller) => await executeProviderRoutingPlan(
            strategy,
            reply,
            deps.requestLogStore,
            deps.promptAffinityStore,
            deps.providerRoutePheromoneStore,
            deps.keyPool,
            providerRoutes,
            executionContext,
            payload,
            availability.prompt_cache_key,
            deps.refreshExpiredOAuthAccount,
            deps.accountHealthStore,
            deps.eventStore,
            deps.quotaMonitor,
            controller.signal,
          ),
        );
      } catch (error) {
        if (sendQueueError(reply, error)) {
          return;
        }
        throw error;
      }

      if (execution.handled) {
        return;
      }

      const federatedResponsesHandled = await runCljsQueued(
        deps.config.cljsPolicyManifestPath,
        { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId, "request-kind": "responses" },
        async (controller) => await deps.executeFederatedRequestRouting({
          requestHeaders: request.headers,
          requestBody,
          requestAuth: request.openHaxAuth ?? undefined,
          requestKind: "responses",
          providerRoutes,
          upstreamPath: "/v1/responses",
          reply,
          timeoutMs: executionContext.upstreamAttemptTimeoutMs,
          signal: controller.signal,
        }),
      );
      if (federatedResponsesHandled) {
        return;
      }

      const bridgedResponsesHandled = await runCljsQueued(
        deps.config.cljsPolicyManifestPath,
        { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId, "request-kind": "responses" },
        async () => await executeBridgeRequestRouting({
          bridgeRelay: deps.bridgeRelay,
          app: deps.app,
          config: deps.config,
          sqlTenantProviderPolicyStore: deps.sqlTenantProviderPolicyStore,
          runtimeCredentialStore: deps.runtimeCredentialStore,
          keyPool: deps.keyPool,
        }, {
          requestHeaders: request.headers,
          requestBody,
          requestAuth: request.openHaxAuth ?? undefined,
          requestKind: "responses",
          allowedProviderIds: providerRoutes.map((route) => route.providerId),
          upstreamPath: "/v1/responses",
          reply,
          timeoutMs: executionContext.upstreamAttemptTimeoutMs,
        }),
      );
      if (bridgedResponsesHandled) {
        return;
      }

      if (hasMoreModelCandidates) {
        continue;
      }

      const sent = await handleRoutingOutcome({
        keyPool: deps.keyPool,
        reply,
        execution,
        availability,
        providerRoutes,
        strategyMode: strategy.mode,
        routedModel: executionContext.routedModel,
        log: app.log,
        logPrefix: "responses passthrough",
      });
      if (sent) {
        return;
      }
    }

    throw openAiRouteError(502, "All allowed providers rejected the request.", "server_error", "provider_unavailable", { requestedModel: requestedModelInput });
  });
}
