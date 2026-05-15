import type { FastifyInstance } from "fastify";

import type { ChatCompletionRequest } from "../lib/request-utils.js";
import { extractPromptCacheKey } from "../lib/openai/index.js";
import { isRecord } from "../lib/provider-utils.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import {
  catalogHasDynamicOllamaModel,
  filterProviderRoutesByCatalogAvailability,
  filterProviderRoutesByModelSupport,
  shouldRejectModelFromProviderCatalog,
} from "../lib/policy/adapters/index.js";
import {
  tenantProviderAllowed,
  filterTenantProviderRoutes,
} from "../lib/policy/engine/index.js";
import {
  selectProviderStrategy,
  executeProviderRoutingPlan,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { allProviderStrategyInfos, selectExecutionStrategyForProviderRoutes } from "../lib/provider-strategy/registry.js";
import { executeLocalStrategy } from "../lib/provider-strategy.js";
import {
  buildProviderRoutesWithDynamicBaseUrls,
  resolveProviderRoutesForModel,
  type ProviderRoute,
} from "../lib/provider-routing.js";
import { orderProviderRoutesByPolicy } from "../lib/provider-policy.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { applyCljsProviderPolicyWithDecision } from "../lib/policy/cljs-shadow.js";
import { sendOpenAiError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";
import { isCephalonAutoModel, reorderCephalonProviderRoutes } from "../lib/provider-strategy/strategies/cephalon.js";
import { isVisionAutoModel, reorderVisionProviderRoutes } from "../lib/provider-strategy/strategies/vision.js";
import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";
import { requestHasExplicitNumCtx } from "../lib/ollama-compat.js";
import { ensureOllamaContextFits } from "../lib/ollama-context.js";
import { executeBridgeRequestFallback } from "../lib/federation/bridge-fallback.js";
import type { AppDeps } from "../lib/app-deps.js";
import type { UpstreamMode } from "../lib/provider-strategy/shared.js";
import { discoverDynamicOllamaRoutes, filterDedicatedOllamaRoutes, hasDedicatedOllamaRoutes, prependDynamicOllamaRoutes } from "../lib/dynamic-ollama-routes.js";
import { rankProviderRoutesWithAco } from "../lib/provider-route-aco.js";

function policyStrategyModeFromDecision(decision: { readonly strategy?: { readonly mode?: string } | string } | undefined): UpstreamMode | undefined {
  const rawMode = typeof decision?.strategy === "string"
    ? decision.strategy
    : decision?.strategy?.mode;
  if (!rawMode) {
    return undefined;
  }

  return rawMode.replace(/-/g, "_") as UpstreamMode;
}

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
        deps.policyEngine,
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
      const policyEvidence = deps.config.cljsPolicyShadowMode === true || deps.config.cljsPolicyAuthoritative === true
        ? await getActiveCljsRuntime()?.loadPolicyEvidence({ providerRoutes }).catch((error: unknown) => {
          request.log.warn({ error, model: context.routedModel }, "CLJS policy evidence load failed");
          return undefined;
        })
        : undefined;
      const cljsPolicyResult = applyCljsProviderPolicyWithDecision({
        config: deps.config,
        log: request.log,
        requestKind: "chat",
        requestedModel: context.requestedModelInput,
        routedModel: context.routedModel,
        tenantSettings: proxySettings,
        providerRoutes,
        policyEvidence,
        strategies: allProviderStrategyInfos(),
      });
      providerRoutes = cljsPolicyResult.providerRoutes;
      const policyPreferredStrategyMode = policyStrategyModeFromDecision(cljsPolicyResult.decision);
      if (policyPreferredStrategyMode) {
        reply.header("x-open-hax-policy-strategy", policyPreferredStrategyMode);
      }

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

      const executionContext = policyPreferredStrategyMode
        ? { ...context, policyPreferredStrategyMode }
        : context;
      const executionStrategy = selectExecutionStrategyForProviderRoutes(
        executionContext,
        strategy,
        providerRoutes.map((route) => route.providerId),
        deps.policyEngine,
        policyPreferredStrategyMode,
      );
      reply.header("x-open-hax-upstream-mode", executionStrategy.mode);

      if (providerRoutes.length === 0) {
        if (executionStrategy.isLocal) {
          // Tenant policy can intentionally clear hosted providers to force the configured local/Ollama edge path.
        } else {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 403, "No allowed providers are available for this tenant and request.", "invalid_request_error", "provider_not_allowed");
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

        if (!executionStrategy.isLocal) {
          providerRoutes = filterProviderRoutesByCatalogAvailability(providerRoutes, context.routedModel, catalogBundle);
          if (wantsDynamicOllamaRoutes && executionStrategy.mode !== "chat_completions") {
            const ranked = await rankProviderRoutesWithAco({
              providerRoutes,
              model: context.routedModel,
              upstreamMode: executionStrategy.mode,
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
        }
      } catch (error) {
        request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog; continuing without gating");
      }

      let payload: ReturnType<typeof executionStrategy.buildPayload>;
      try {
        payload = executionStrategy.buildPayload(executionContext);
      } catch (error) {
        if (hasMoreModelCandidates) {
          continue;
        }
        sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
        return;
      }

      if (executionStrategy.mode === "ollama_chat" || executionStrategy.mode === "local_ollama_chat") {
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

      if (executionStrategy.isLocal) {
        if (!tenantProviderAllowed(proxySettings, "ollama")) {
          if (hasMoreModelCandidates) {
            continue;
          }
          sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
          return;
        }

        await executeLocalStrategy(executionStrategy, reply, deps.requestLogStore, executionContext, payload);
        return;
      }

      for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
        await deps.ensureFreshAccounts(providerId);
      }

      const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes);
      const promptCacheKey = extractPromptCacheKey(requestBody);
      const shouldPreferFederatedProjectedAccounts = policyPreferredStrategyMode === undefined
        && dynamicOllamaRoutes.length > 0
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
        executionStrategy,
        reply,
        deps.requestLogStore,
        deps.promptAffinityStore,
        deps.providerRoutePheromoneStore,
        deps.keyPool,
        providerRoutes,
        executionContext,
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
        allowedProviderIds: providerRoutes.map((route) => route.providerId),
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
        strategyMode: executionStrategy.mode,
        routedModel: context.routedModel,
        log: app.log,
      });
      if (sent) {
        return;
      }
    }

    sendOpenAiError(reply, 502, "All allowed providers rejected the request.", "server_error", "provider_unavailable");
  });
}
