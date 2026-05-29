import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import {
  filterDeclaredProviderRoutes,
  filterImagesApiRoutes,
  getDeclaredProviderRoutes,
} from "../lib/provider-routing.js";
import {
  inspectProviderAvailability,
  executeProviderRoutingPlan,
  selectProviderStrategy,
} from "../lib/provider-strategy.js";
import { isRecord, OpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";

function openAiRouteError(statusCode: number, message: string, type: string, code: string, meta?: Record<string, unknown>, cause?: unknown): OpenAiHttpError {
  return new OpenAiHttpError({ statusCode, message, type, code, meta, cause });
}

export function registerImagesRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/images/generations", async (request, reply) => {
    if (!isRecord(request.body)) {
      throw openAiRouteError(400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      (request.openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    const requestBody = request.body;
    const model = typeof requestBody.model === "string" ? requestBody.model : "";
    if (model.length === 0) {
      throw openAiRouteError(400, "Missing required field: model", "invalid_request_error", "missing_model");
    }

    const { strategy, context } = selectProviderStrategy(
      deps.config,
      request.headers,
      requestBody,
      model,
      model,
      request.openHaxAuth ?? undefined,
      { surface: "images-passthrough" },
    );
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      throw openAiRouteError(400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options", { requestedModel: model }, error);
    }

    let providerRoutes = filterImagesApiRoutes(
      getDeclaredProviderRoutes(deps.config),
      deps.config.openaiProviderId,
    );
    providerRoutes = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
      config: deps.config,
      modelId: context.routedModel || context.requestedModelInput,
      requestKind: "images-passthrough",
      tenantSettings,
      providerRoutes,
    }).providerRoutes;

    if (providerRoutes.length === 0) {
      throw openAiRouteError(403, "No allowed providers are available for this tenant and request.", "invalid_request_error", "provider_not_allowed", { routedModel: context.routedModel });
    }

    for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
      await deps.ensureFreshAccounts(providerId);
    }

    const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes);
    let execution: Awaited<ReturnType<typeof executeProviderRoutingPlan>>;
    try {
      execution = await runCljsQueued(
        deps.config.cljsPolicyManifestPath,
        {
          "tenant-id": request.openHaxAuth?.tenantId ?? "default",
          "provider-id": providerRoutes[0]?.providerId,
          "request-kind": "images",
        },
        async (controller) => await executeProviderRoutingPlan(
          strategy,
          reply,
          deps.requestLogStore,
          deps.promptAffinityStore,
          deps.providerRoutePheromoneStore,
          deps.keyPool,
          providerRoutes,
          context,
          payload,
          undefined,
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

    const federatedImagesHandled = await runCljsQueued(
      deps.config.cljsPolicyManifestPath,
      { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": providerRoutes[0]?.providerId, "request-kind": "images" },
      async (controller) => await deps.executeFederatedRequestFallback({
        requestHeaders: request.headers,
        requestBody,
        requestAuth: request.openHaxAuth ?? undefined,
        providerRoutes,
        upstreamPath: "/v1/images/generations",
        reply,
        timeoutMs: context.upstreamAttemptTimeoutMs,
        signal: controller.signal,
      }),
    );
    if (federatedImagesHandled) {
      return;
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
      logPrefix: "images",
    });
    if (sent) {
      return;
    }

    throw openAiRouteError(502, "All allowed image providers rejected the request.", "server_error", "provider_unavailable", { routedModel: context.routedModel });
  });
}
