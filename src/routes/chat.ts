import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ChatCompletionRequest } from "../lib/request-utils.js";
import { extractPromptCacheKey } from "../lib/openai/index.js";
import { isRecord, OpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import {
  selectProviderStrategy,
  executeProviderRoutingPlan,
  inspectProviderAvailability,
} from "../lib/provider-strategy.js";
import { selectExecutionStrategyForProviderRoutes } from "../lib/provider-strategy/registry.js";
import { executeLocalStrategy } from "../lib/provider-strategy.js";
import {
  filterDeclaredProviderRoutes,
  getDeclaredProviderRoutes,
  type ProviderRoute,
  type ResolvedModelCatalog,
} from "../lib/provider-routing.js";
import { getActiveCljsRuntime, type CljsModelCandidatesRunResult } from "../lib/cljs-runtime.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";
import { isCephalonAutoModel } from "../lib/provider-strategy/strategies/cephalon.js";
import { requestHasExplicitNumCtx } from "../lib/ollama-compat.js";
import { ensureOllamaContextFits } from "../lib/ollama-context.js";
import { executeBridgeRequestRouting } from "../lib/federation/bridge-routing.js";
import type { AppDeps } from "../lib/app-deps.js";
import type { StrategyRequestContext } from "../lib/provider-strategy/shared.js";

function openAiRouteError(statusCode: number, message: string, type: string, code: string, meta?: Record<string, unknown>): OpenAiHttpError {
  return new OpenAiHttpError({ statusCode, message, type, code, meta });
}

function applyPolicyStrategyContext(
  context: StrategyRequestContext,
  policyResult: { readonly strategyMode?: StrategyRequestContext["policyPreferredStrategyMode"]; readonly strategyModeByProvider?: StrategyRequestContext["policyPreferredStrategyModeByProvider"] },
): StrategyRequestContext {
  return {
    ...context,
    ...(policyResult.strategyMode ? { policyPreferredStrategyMode: policyResult.strategyMode } : {}),
    ...(policyResult.strategyModeByProvider ? { policyPreferredStrategyModeByProvider: policyResult.strategyModeByProvider } : {}),
  };
}

function prioritizeOpenAiRouteForPrefixedModel(
  routes: readonly ProviderRoute[],
  context: StrategyRequestContext,
): ProviderRoute[] {
  if (!context.openAiPrefixed) {
    return [...routes];
  }

  const openAiProviderId = context.config.openaiProviderId;
  return [...routes].sort((left, right) => {
    const leftRank = left.providerId === openAiProviderId ? 0 : 1;
    const rightRank = right.providerId === openAiProviderId ? 0 : 1;
    return leftRank - rightRank;
  });
}

interface ChatCandidateInput {
  readonly deps: AppDeps;
  readonly app: FastifyInstance;
  readonly request: FastifyRequest<{ Body: ChatCompletionRequest }>;
  readonly reply: FastifyReply;
  readonly proxySettings: Awaited<ReturnType<AppDeps["proxySettingsStore"]["getForTenant"]>>;
  readonly requestBody: ChatCompletionRequest;
  readonly requestedModelInput: string;
  readonly routingModelInput: string;
  readonly candidateRoutingModel: string;
  readonly hasMoreModelCandidates: boolean;
  readonly resolvedModelCatalog?: ResolvedModelCatalog | null;
}

async function executeChatCandidate(input: ChatCandidateInput): Promise<CljsModelCandidatesRunResult> {
  const {
    deps,
    app,
    request,
    reply,
    proxySettings,
    requestBody,
    requestedModelInput,
    routingModelInput,
    candidateRoutingModel,
    hasMoreModelCandidates,
    resolvedModelCatalog,
  } = input;

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

  let providerRoutes: ProviderRoute[];
  if (context.factoryPrefixed) {
    providerRoutes = getDeclaredProviderRoutes(deps.config).filter(
      (route) => route.providerId === "factory",
    );
  } else if (context.explicitOllama) {
    providerRoutes = getDeclaredProviderRoutes(deps.config).filter(
      (route) => route.providerId === "ollama",
    );
  } else {
    providerRoutes = getDeclaredProviderRoutes(deps.config);
  }

  const cljsPolicyResult = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
    config: deps.config,
    modelId: context.routedModel || context.requestedModelInput,
    requestKind: "chat",
    tenantSettings: proxySettings,
    providerRoutes,
  });
  providerRoutes = prioritizeOpenAiRouteForPrefixedModel(cljsPolicyResult.providerRoutes, context);

  let executionContext = applyPolicyStrategyContext(context, cljsPolicyResult);
  let executionStrategy = selectExecutionStrategyForProviderRoutes(
    executionContext,
    strategy,
    providerRoutes.map((route) => route.providerId),
  );
  reply.header("x-open-hax-upstream-mode", executionStrategy.mode);

  if (providerRoutes.length === 0 && !executionStrategy.isLocal) {
    if (hasMoreModelCandidates) {
      return { status: "continue" };
    }
    throw openAiRouteError(403, "No allowed providers are available for this tenant and request.", "invalid_request_error", "provider_not_allowed", { routedModel: context.routedModel });
  }

  try {
      const catalogResult = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
        config: deps.config,
        modelId: context.routedModel || context.requestedModelInput,
        requestKind: "chat",
        tenantSettings: proxySettings,
        providerRoutes,
        catalogBundle: await deps.providerCatalogStore.getCatalog(),
      catalogAvailability: !executionStrategy.isLocal,
    });
    providerRoutes = prioritizeOpenAiRouteForPrefixedModel(catalogResult.providerRoutes, context);
    executionContext = applyPolicyStrategyContext(executionContext, catalogResult);
    executionStrategy = selectExecutionStrategyForProviderRoutes(
      executionContext,
      strategy,
      providerRoutes.map((route) => route.providerId),
    );
    reply.header("x-open-hax-upstream-mode", executionStrategy.mode);
    if (catalogResult.catalog?.disabled) {
      if (hasMoreModelCandidates) {
        return { status: "continue" };
      }
      throw openAiRouteError(403, `Model is disabled: ${context.routedModel}`, "invalid_request_error", "model_disabled", { routedModel: context.routedModel });
    }

    if (!executionStrategy.isLocal) {
      if (providerRoutes.length === 0) {
        if (hasMoreModelCandidates) {
          return { status: "continue" };
        }
        throw openAiRouteError(503, "No healthy Ollama nodes are currently available.", "server_error", "healthy_nodes_unavailable", { routedModel: context.routedModel });
      }

      if (catalogResult.catalog?.rejected) {
        if (hasMoreModelCandidates) {
          return { status: "continue" };
        }
        throw openAiRouteError(404, `Model not found: ${context.routedModel}`, "invalid_request_error", "model_not_found", { routedModel: context.routedModel });
      }
    }
  } catch (error) {
    if (error instanceof OpenAiHttpError) {
      throw error;
    }
    request.log.warn({ error: toErrorMessage(error) }, "failed to verify provider model catalog; continuing without gating");
  }

  let payload: ReturnType<typeof executionStrategy.buildPayload>;
  try {
    payload = executionStrategy.buildPayload(executionContext);
  } catch (error) {
    if (hasMoreModelCandidates) {
      return { status: "continue" };
    }
    throw openAiRouteError(400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options", { routedModel: context.routedModel });
  }

  if (executionStrategy.mode === "ollama_chat" || executionStrategy.mode === "local_ollama_chat") {
    const candidateRequestBody = payload.upstreamPayload;
    if (isRecord(candidateRequestBody) && !requestHasExplicitNumCtx(requestBody)) {
      const ollamaUrl = deps.config.ollamaBaseUrl;
      const budget = await runCljsQueued(
        deps.config.cljsPolicyManifestPath,
        { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId ?? "ollama", "request-kind": "chat" },
        async (controller) => await ensureOllamaContextFits(ollamaUrl, candidateRequestBody, Math.min(deps.config.requestTimeoutMs, 30_000), controller.signal),
      );
      if (budget && budget.requiredContextTokens > budget.availableContextTokens) {
        if (hasMoreModelCandidates) {
          return { status: "continue" };
        }
        throw openAiRouteError(
          400,
          `Request exceeds model context window for ${budget.model}. Estimated input tokens: ${budget.estimatedInputTokens}, requested output tokens: ${budget.requestedOutputTokens}, required total: ${budget.requiredContextTokens}, available: ${budget.availableContextTokens}. Reduce input size or request a larger context/model.`,
          "invalid_request_error",
          "ollama_context_overflow",
          { routedModel: context.routedModel, budget },
        );
      }
    }
  }

  if (executionStrategy.isLocal) {
    try {
      await runCljsQueued(
        deps.config.cljsPolicyManifestPath,
        { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": "ollama", "request-kind": "chat" },
        async (controller) => await executeLocalStrategy(executionStrategy, reply, deps.requestLogStore, executionContext, payload, controller.signal),
      );
    } catch (error) {
      if (sendQueueError(reply, error)) {
        return { status: "handled" };
      }
      throw error;
    }
    return { status: "handled" };
  }

  for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
    await deps.ensureFreshAccounts(providerId);
  }

  const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes);
  const promptCacheKey = extractPromptCacheKey(requestBody);
  let execution: Awaited<ReturnType<typeof executeProviderRoutingPlan>>;
  try {
    execution = await runCljsQueued(
      deps.config.cljsPolicyManifestPath,
      {
        "tenant-id": request.openHaxAuth?.tenantId ?? "default",
        "provider-id": providerRoutes[0]?.providerId,
        "request-kind": "chat",
      },
      async (controller) => await executeProviderRoutingPlan(
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
        deps.accountHealthStore,
        deps.eventStore,
        deps.quotaMonitor,
        controller.signal,
      ),
    );
  } catch (error) {
    if (sendQueueError(reply, error)) {
      return { status: "handled" };
    }
    throw error;
  }

  if (execution.handled) {
    return { status: "handled" };
  }

  const federatedChatHandled = await runCljsQueued(
    deps.config.cljsPolicyManifestPath,
    { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId, "request-kind": "chat" },
    async (controller) => await deps.executeFederatedRequestRouting({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: requestAuth as { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string },
      requestKind: "chat",
      providerRoutes,
      upstreamPath: "/v1/chat/completions",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
      signal: controller.signal,
    }),
  );
  if (federatedChatHandled) {
    return { status: "handled" };
  }

  const bridgedChatHandled = await runCljsQueued(
    deps.config.cljsPolicyManifestPath,
    { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId, "request-kind": "chat" },
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
      requestKind: "chat",
      allowedProviderIds: providerRoutes.map((route) => route.providerId),
      upstreamPath: "/v1/chat/completions",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    }),
  );
  if (bridgedChatHandled) {
    return { status: "handled" };
  }

  if (hasMoreModelCandidates) {
    return { status: "continue" };
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
  return { status: sent ? "handled" : "continue" };
}

async function runChatCandidates(input: Omit<ChatCandidateInput, "candidateRoutingModel" | "hasMoreModelCandidates"> & {
  readonly routingModelCandidates: readonly string[];
}): Promise<CljsModelCandidatesRunResult> {
  const runtime = getActiveCljsRuntime();
  const executeCandidate = async (candidateRoutingModel: string, hasMoreModelCandidates: boolean) => await executeChatCandidate({
    ...input,
    candidateRoutingModel,
    hasMoreModelCandidates,
  });

  if (runtime?.runModelCandidates) {
    return await runtime.runModelCandidates(
      input.deps.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
      { candidates: input.routingModelCandidates },
      executeCandidate,
    );
  }

  for (const [index, candidateRoutingModel] of input.routingModelCandidates.entries()) {
    const result = await executeCandidate(candidateRoutingModel, index < input.routingModelCandidates.length - 1);
    if (result.status !== "continue") {
      return result;
    }
  }
  return { status: "exhausted" };
}

export function registerChatRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", async (request, reply) => {
    if (!isRecord(request.body)) {
      throw openAiRouteError(400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
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

    const result = await runChatCandidates({
      deps,
      app,
      request,
      reply,
      proxySettings,
      requestBody,
      requestedModelInput: modelRouting.requestedModelInput,
      routingModelInput: modelRouting.routingModelInput,
      routingModelCandidates: modelRouting.routingModelCandidates,
      resolvedModelCatalog: modelRouting.resolvedModelCatalog,
    });
    if (result.status !== "continue" && result.status !== "exhausted") {
      return;
    }

    throw openAiRouteError(502, "All allowed providers rejected the request.", "server_error", "provider_unavailable", {
      requestedModel: modelRouting.requestedModelInput,
    });
  });
}
