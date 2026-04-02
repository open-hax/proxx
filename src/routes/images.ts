import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { resolveExplicitTenantProviderId } from "../lib/tenant-policy-helpers.js";
import {
  filterTenantProviderRoutes,
} from "../lib/tenant-policy-helpers.js";
import {
  filterImagesApiRoutes,
  buildProviderRoutesWithDynamicBaseUrls,
} from "../lib/provider-routing.js";
import {
  orderProviderRoutesByPolicy,
} from "../lib/provider-policy.js";
import {
  inspectProviderAvailability,
  executeProviderRoutingPlan,
} from "../lib/provider-strategy.js";
import { buildImagesPassthroughContext } from "../lib/provider-strategy.js";
import { isRecord, sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";

export function registerImagesRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/images/generations", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      (request.openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    const requestBody = request.body;
    const model = typeof requestBody.model === "string" ? requestBody.model : "";
    if (model.length === 0) {
      sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
      return;
    }

    const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(deps.config, model, tenantSettings);
    if (explicitlyBlockedProviderId) {
      sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
      return;
    }

    const { strategy, context } = buildImagesPassthroughContext(
      deps.config,
      request.headers,
      requestBody,
      model,
      request.openHaxAuth ?? undefined,
    );
    reply.header("x-open-hax-upstream-mode", strategy.mode);

    let payload: ReturnType<typeof strategy.buildPayload>;
    try {
      payload = strategy.buildPayload(context);
    } catch (error) {
      sendOpenAiError(reply, 400, toErrorMessage(error), "invalid_request_error", "invalid_provider_options");
      return;
    }

    let providerRoutes = filterImagesApiRoutes(
      await buildProviderRoutesWithDynamicBaseUrls(deps.config, context.openAiPrefixed, deps.dynamicProviderBaseUrlGetter, true),
      deps.config.openaiProviderId,
    );
    providerRoutes = filterTenantProviderRoutes(providerRoutes, tenantSettings);
    providerRoutes = orderProviderRoutesByPolicy(deps.policyEngine, providerRoutes, context.requestedModelInput, context.routedModel, {
      openAiPrefixed: context.openAiPrefixed,
      localOllama: false,
      explicitOllama: false,
    });

    if (providerRoutes.length === 0) {
      sendOpenAiError(reply, 403, "No upstream providers are allowed for this tenant and request.", "invalid_request_error", "provider_not_allowed");
      return;
    }

    for (const providerId of new Set(providerRoutes.map((route) => route.providerId))) {
      await deps.ensureFreshAccounts(providerId);
    }

    const availability = await inspectProviderAvailability(deps.keyPool, providerRoutes);
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
      undefined,
      deps.refreshExpiredOAuthAccount,
      deps.policyEngine,
      deps.accountHealthStore,
      deps.eventStore,
      deps.quotaMonitor,
    );

    if (execution.handled) {
      return;
    }

    const federatedImagesHandled = await deps.executeFederatedRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: request.openHaxAuth ?? undefined,
      providerRoutes,
      upstreamPath: "/v1/images/generations",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
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
  });
}
