import type { FastifyInstance } from "fastify";

import { type ChatCompletionRequest, extractPromptCacheKey } from "../lib/request-utils.js";
import { isRecord } from "../lib/provider-utils.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import {
  catalogHasDynamicOllamaModel,
  filterProviderRoutesByCatalogAvailability,
  filterProviderRoutesByModelSupport,
  shouldRejectModelFromProviderCatalog,
} from "../lib/model-routing-helpers.js";
import {
  tenantProviderAllowed,
  filterTenantProviderRoutes,
} from "../lib/tenant-policy-helpers.js";
import {
  selectProviderStrategy,
  executeProviderRoutingPlan,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { executeLocalStrategy } from "../lib/provider-strategy.js";
import {
  buildProviderRoutesWithDynamicBaseUrls,
  resolveProviderRoutesForModel,
  type ProviderRoute,
} from "../lib/provider-routing.js";
import { orderProviderRoutesByPolicy } from "../lib/provider-policy.js";
import { sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";
import { isCephalonAutoModel, reorderCephalonProviderRoutes } from "../lib/provider-strategy/strategies/cephalon.js";
import { isVisionAutoModel, reorderVisionProviderRoutes } from "../lib/provider-strategy/strategies/vision.js";
import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";
import { requestHasExplicitNumCtx } from "../lib/ollama-compat.js";
import { ensureOllamaContextFits } from "../lib/ollama-context.js";
import { executeBridgeRequestFallback } from "../lib/federation/bridge-fallback.js";
import type { AppDeps } from "../lib/app-deps.js";
import { discoverDynamicOllamaRoutes, filterDedicatedOllamaRoutes, hasDedicatedOllamaRoutes, prependDynamicOllamaRoutes } from "../lib/dynamic-ollama-routes.js";
import { rankProviderRoutesWithAco } from "../lib/provider-route-aco.js";

export function registerChatRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const proxySettings = await deps.proxySettingsStore.getForTenant(
      (request.openHaxAuth?.tenantId) ?? "default",
    );
    const requestBody = proxySettings.fastMode
      ? {
        open_hax: {
          fast_mode: true,
          ...(isRecord(request.body.open_hax) ? request.body.open_hax : {}),
        },
        ...request.body,
      }
      : request.body;

    if (proxySettings.fastMode) {
      reply.header("x-open-hax-fast-mode", "priority");
    }

    const modelRouting = await resolveModelRouting(
      {
        config: deps.config,
        proxySettings,
        providerCatalogStore: deps.providerCatalogStore,
        requestLogStore: deps.requestLogStore,
        accountHealthStore: deps.accountHealthStore,
      },
      requestBody,
      reply,
      request.log,
      { preserveExplicitOllama: true },
    );
    if (!modelRouting) {
      return;
    }
    const { requestedModelInput, routingModelInput, resolvedModelCatalog, routingModelCandidates } = modelRouting;
    const dynamicOllamaModelIds = resolvedModelCatalog?.dynamicOllamaModelIds;

    for (const [candidateIndex, candidateRoutingModel] of routingModelCandidates.entries()) {
      const hasMoreModelCandidates = candidateIndex < routingModelCandidates.length - 1;
      const { strategy, context } = selectProviderStrategy(
        deps.config,
        request.headers,
        requestBody,
        requestedModelInput,
        candidateRoutingModel,
        request.openHaxAuth ?? undefined,
      );
      reply.header("x-open-hax-upstream-mode", strategy.mode);
      const requestAuth = request.openHaxAuth ?? undefined;
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
        providerRoutes = await buildProviderRoutesWithDynamicBaseUrls(
          deps.config,
          context.openAiPrefixed,
          deps.dynamicProviderBaseUrlGetter,
          !context.openAiPrefixed && strategy.mode === "responses"
        );
        if (!context.openAiPrefixed && resolvedModelCatalog) {
          providerRoutes = resolveProviderRoutesForModel(providerRoutes, context.routedModel, resolvedModelCatalog);
        }
      }
      const wantsDynamicOllamaRoutes = context.localOllama
        || isCephalonAutoModel(requestedModelInput)
        || isCephalonAutoModel(routingModelInput)
        || catalogHasDynamicOllamaModel(resolvedModelCatalog, context.routedModel);
      const dynamicOllamaRoutes = wantsDynamicOllamaRoutes
        ? await discoverDynamicOllamaRoutes(deps.sqlCredentialStore, deps.sqlFederationStore, federationOwnerSubject)
        : [];

      if (wantsDynamicOllamaRoutes && dynamicOllamaRoutes.length > 0) {
        providerRoutes = prependDynamicOllamaRoutes(providerRoutes, dynamicOllamaRoutes);
      }
      if (wantsDynamicOllamaRoutes) {
        const dedicatedOllamaRoutes = filterDedicatedOllamaRoutes(providerRoutes);
        if (dedicatedOllamaRoutes.length > 0) {
          providerRoutes = dedicatedOllamaRoutes;
        }
      }
      providerRoutes = filterProviderRoutesByModelSupport(deps.config, providerRoutes, context.routedModel);
      providerRoutes = filterTenantProviderRoutes(providerRoutes, proxySettings);
      providerRoutes = orderProviderRoutesByPolicy(deps.policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
        openAiPrefixed: context.openAiPrefixed,
        localOllama: context.localOllama,
        explicitOllama: context.explicitOllama,
      });

      if (isCephalonAutoModel(requestedModelInput) || isCephalonAutoModel(routingModelInput)) {
        const prioritizedDynamicOllamaRoutes = dynamicOllamaModelIds && resolvedModelCatalog
          ? dynamicOllamaRoutes.filter((route) => {
            const providerId = route.providerId.toLowerCase();
            return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
          })
          : dynamicOllamaRoutes;
        providerRoutes = reorderCephalonProviderRoutes(providerRoutes, prioritizedDynamicOllamaRoutes);
      }
      if (isVisionAutoModel(requestedModelInput) || isVisionAutoModel(routingModelInput)) {
        providerRoutes = reorderVisionProviderRoutes(providerRoutes, context.routedModel);
      }

      if (providerRoutes.length === 0) {
        if (strategy.isLocal) {
          // Tenant policy can intentionally clear hosted providers to force the configured local/Ollama edge path.
        } else {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
          return;
        }
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

        providerRoutes = filterProviderRoutesByCatalogAvailability(providerRoutes, context.routedModel, catalogBundle);
        if (wantsDynamicOllamaRoutes) {
          const ranked = await rankProviderRoutesWithAco({
            providerRoutes,
            model: context.routedModel,
            upstreamMode: strategy.mode,
            keyPool: deps.keyPool,
            requestLogStore: deps.requestLogStore,
            healthStore: deps.accountHealthStore,
            pheromoneStore: deps.providerRoutePheromoneStore,
          });
          providerRoutes = ranked.orderedRoutes;
        }

        if (providerRoutes.length === 0) {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 503, "No healthy Ollama nodes are currently available.", "server_error", "healthy_nodes_unavailable");
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
        request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog; continuing without gating");
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

      if (strategy.mode === "ollama_chat" || strategy.mode === "local_ollama_chat") {
        const candidateRequestBody = payload.upstreamPayload;
        if (isRecord(candidateRequestBody) && !requestHasExplicitNumCtx(requestBody) && !hasDedicatedOllamaRoutes(providerRoutes)) {
          const ollamaUrl = providerRoutes.length > 0 ? providerRoutes[0]!.baseUrl : deps.config.ollamaBaseUrl;
          const budget = await ensureOllamaContextFits(ollamaUrl, candidateRequestBody, Math.min(deps.config.requestTimeoutMs, 30_000));
          if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
            if (hasMoreModelCandidates) {
              continue;
            }
            sendOpenAiError(
              reply,
              400,
              `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or request a larger context/model.`,
              "invalid_request_error",
              "ollama_context_overflow"
            );
            return;
          }
        }
      }

      if (strategy.isLocal) {
        if (!tenantProviderAllowed(proxySettings, "ollama")) {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
          return;
        }

        await executeLocalStrategy(strategy, reply, deps.requestLogStore, context, payload);
        return;
      }

      for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
        await deps.ensureFreshAccounts(providerId);
      }

      const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes);
      const promptCacheKey = extractPromptCacheKey(requestBody);
      const shouldPreferFederatedProjectedAccounts = dynamicOllamaRoutes.length > 0
        && (context.localOllama || isCephalonAutoModel(requestedModelInput) || isCephalonAutoModel(routingModelInput));

      if (shouldPreferFederatedProjectedAccounts) {
        const federatedChatHandled = await deps.executeFederatedRequestFallback({
          requestHeaders: request.headers,
          requestBody,
          requestAuth: requestAuth as { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string },
          providerRoutes,
          upstreamPath: "/v1/chat/completions",
          reply,
          timeoutMs: context.upstreamAttemptTimeoutMs,
        });
        if (federatedChatHandled) {
          return;
        }
      }

      const execution = await executeProviderRoutingPlan(
        strategy,
        reply,
        deps.requestLogStore,
        deps.promptAffinityStore,
        deps.providerRoutePheromoneStore,
        deps.keyPool,
        providerRoutes,
        context,
        payload,
        promptCacheKey,
        deps.refreshExpiredOAuthAccount,
        deps.policyEngine,
        deps.accountHealthStore,
        deps.eventStore,
        deps.quotaMonitor,
      );

      if (execution.handled) {
        return;
      }

      const federatedChatHandled = await deps.executeFederatedRequestFallback({
        requestHeaders: request.headers,
        requestBody,
        requestAuth: requestAuth as { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string },
        providerRoutes,
        upstreamPath: "/v1/chat/completions",
        reply,
        timeoutMs: context.upstreamAttemptTimeoutMs,
      });
      if (federatedChatHandled) {
        return;
      }

      const bridgedChatHandled = await executeBridgeRequestFallback({
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
        upstreamPath: "/v1/chat/completions",
        reply,
        timeoutMs: context.upstreamAttemptTimeoutMs,
      });
      if (bridgedChatHandled) {
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
        routedModel: context.routedModel,
        log: app.log,
      });
      if (sent) {
        return;
      }
    }

    sendOpenAiError(reply, 502, "Upstream rejected the request with no successful fallback.", "server_error", "upstream_unavailable");
  });
}
