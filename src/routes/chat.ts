import type { FastifyInstance } from "fastify";

import { type ChatCompletionRequest, extractPromptCacheKey } from "../lib/request-utils.js";
import { isRecord } from "../lib/provider-utils.js";
import {
  resolvableConcreteModelIds,
  filterProviderRoutesByModelSupport,
  shouldRejectModelFromProviderCatalog,
} from "../lib/model-routing-helpers.js";
import {
  tenantProviderAllowed,
  filterTenantProviderRoutes,
  resolveExplicitTenantProviderId,
} from "../lib/tenant-policy-helpers.js";
import {
  selectProviderStrategy,
  executeProviderFallback,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { executeLocalStrategy } from "../lib/provider-strategy.js";
import {
  buildProviderRoutesWithDynamicBaseUrls,
  resolveProviderRoutesForModel,
  minMsUntilAnyProviderKeyReady,
  type ProviderRoute,
} from "../lib/provider-routing.js";
import { orderProviderRoutesByPolicy } from "../lib/provider-policy.js";
import { sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";
import { isAutoModel, rankAutoModels } from "../lib/auto-model-selector.js";
import { isCephalonAutoModel, buildCephalonModelCandidates, reorderCephalonProviderRoutes } from "../lib/provider-strategy/strategies/cephalon.js";
import { requestHasExplicitNumCtx } from "../lib/ollama-compat.js";
import { ensureOllamaContextFits } from "../lib/ollama-context.js";
import { executeBridgeRequestFallback } from "../lib/federation/bridge-fallback.js";
import type { AppDeps } from "../lib/app-deps.js";

export function registerChatRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const proxySettings = await deps.proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? "default",
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

    const requestedModelInput = typeof requestBody.model === "string" ? requestBody.model : "";
    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(deps.config, requestedModelInput, proxySettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    let routingModelInput = requestedModelInput;
    let resolvedModelCatalog = null;
    try {
      const catalogBundle = await deps.providerCatalogStore.getCatalog();
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
      request.log.warn({ error: toErrorMessage(error) }, "failed to resolve dynamic model aliases; using requested model as-is");
    }

    const concreteModelIds = resolvableConcreteModelIds(resolvedModelCatalog);
    const dynamicOllamaModelIds = resolvedModelCatalog?.dynamicOllamaModelIds;

    const routingModelCandidates = (() => {
      if (isCephalonAutoModel(routingModelInput)) {
        return buildCephalonModelCandidates({
          routingModelInput,
          requestBody,
          catalog: resolvedModelCatalog,
          availableModels: concreteModelIds,
          providerId: deps.config.upstreamProviderId,
          requestLogStore: deps.requestLogStore,
          accountHealthStore: deps.accountHealthStore,
        });
      }
      if (isAutoModel(routingModelInput)) {
        return rankAutoModels(
          routingModelInput,
          requestBody,
          concreteModelIds,
          deps.config.upstreamProviderId,
          deps.requestLogStore,
          deps.accountHealthStore,
        ).map((entry) => entry.modelId);
      }
      return [routingModelInput];
    })();

    if (routingModelCandidates.length === 0) {
      sendOpenAiError(reply, 404, `Model not found: ${requestedModelInput}`, "invalid_request_error", "model_not_found");
      return;
    }

    if (isAutoModel(routingModelInput)) {
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
        (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
      );
      reply.header("x-open-hax-upstream-mode", strategy.mode);

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
      if (context.explicitOllama && deps.sqlCredentialStore) {
        providerRoutes = [...providerRoutes];
      }
      providerRoutes = filterProviderRoutesByModelSupport(deps.config, providerRoutes, context.routedModel);
      providerRoutes = filterTenantProviderRoutes(providerRoutes, proxySettings);
      providerRoutes = orderProviderRoutesByPolicy(deps.policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
        openAiPrefixed: context.openAiPrefixed,
        localOllama: context.localOllama,
        explicitOllama: context.explicitOllama,
      });

      if (isCephalonAutoModel(requestedModelInput) || isCephalonAutoModel(routingModelInput)) {
        const dynamicOllamaRoutes = dynamicOllamaModelIds && resolvedModelCatalog
          ? providerRoutes.filter((route) => {
            const providerId = route.providerId.toLowerCase();
            return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
          })
          : undefined;
        providerRoutes = reorderCephalonProviderRoutes(providerRoutes, dynamicOllamaRoutes);
      }

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
        if (isRecord(candidateRequestBody) && !requestHasExplicitNumCtx(requestBody)) {
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
      const execution = await executeProviderFallback(
        strategy,
        reply,
        deps.requestLogStore,
        deps.promptAffinityStore,
        deps.keyPool,
        providerRoutes,
        context,
        payload,
        promptCacheKey,
        deps.refreshExpiredOAuthAccount,
        deps.policyEngine,
        deps.accountHealthStore,
        deps.eventStore,
        undefined,
      );

      if (execution.handled) {
        return;
      }

      const federatedChatHandled = await deps.executeFederatedRequestFallback({
        requestHeaders: request.headers,
        requestBody,
        requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
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
        requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
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

      if (execution.candidateCount === 0) {
        const retryInMs = await minMsUntilAnyProviderKeyReady(deps.keyPool, providerRoutes);
        if (retryInMs > 0) {
          reply.header("retry-after", Math.ceil(retryInMs / 1000));
        }

        if (!availability.sawConfiguredProvider) {
          sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration", "server_error", "keys_unavailable");
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
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream invalid-request responses");
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

        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream rate limits");
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
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to upstream server errors");
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
        app.log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode }, "all attempts exhausted due to model-not-found responses");
        sendOpenAiError(
          reply,
          404,
          `Model not found across available upstream providers: ${context.routedModel}`,
          "invalid_request_error",
          "model_not_found"
        );
        return;
      }

      const message = summary.sawRequestError
        ? "All upstream attempts failed due to network/transport errors."
        : "Upstream rejected the request with no successful fallback.";

      app.log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategy.mode, sawRequestError: summary.sawRequestError }, "all upstream attempts exhausted");
      sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
      return;
    }

    sendOpenAiError(reply, 502, "Upstream rejected the request with no successful fallback.", "server_error", "upstream_unavailable");
  });
}
