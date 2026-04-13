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
  executeProviderFallback,
} from "../lib/provider-strategy.js";
import { buildImagesPassthroughContext } from "../lib/provider-strategy.js";
import {
  minMsUntilAnyProviderKeyReady,
} from "../lib/provider-routing.js";
import { isRecord, sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";

export function registerImagesRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/images/generations", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
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
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
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
    const execution = await executeProviderFallback(
      strategy,
      reply,
      deps.requestLogStore,
      deps.promptAffinityStore,
      deps.keyPool,
      providerRoutes,
      context,
      payload,
      undefined,
      deps.refreshExpiredOAuthAccount,
      deps.policyEngine,
      deps.accountHealthStore,
      deps.eventStore,
    );

    if (execution.handled) {
      return;
    }

    const federatedImagesHandled = await deps.executeFederatedRequestFallback({
      requestHeaders: request.headers,
      requestBody,
      requestAuth: (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string } }).openHaxAuth,
      providerRoutes,
      upstreamPath: "/v1/images/generations",
      reply,
      timeoutMs: context.upstreamAttemptTimeoutMs,
    });
    if (federatedImagesHandled) {
      return;
    }

    if (execution.candidateCount === 0) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(deps.keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      if (!availability.sawConfiguredProvider) {
        sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration for image generation providers", "server_error", "keys_unavailable");
        return;
      }

      sendOpenAiError(
        reply,
        429,
        "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
        "rate_limit_error",
        "all_keys_rate_limited",
      );
      return;
    }

    const { summary } = execution;

    if (summary.sawUpstreamInvalidRequest) {
      sendOpenAiError(
        reply,
        400,
        "No upstream account accepted the image generation payload. Check model availability and request parameters.",
        "invalid_request_error",
        "upstream_rejected_request",
      );
      return;
    }

    if (summary.sawRateLimit) {
      const retryInMs = await minMsUntilAnyProviderKeyReady(deps.keyPool, providerRoutes);
      if (retryInMs > 0) {
        reply.header("retry-after", Math.ceil(retryInMs / 1000));
      }

      sendOpenAiError(
        reply,
        429,
        "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
        "rate_limit_error",
        "no_available_key",
      );
      return;
    }

    if (summary.sawUpstreamServerError) {
      sendOpenAiError(
        reply,
        502,
        "Upstream returned transient server errors across all available accounts.",
        "server_error",
        "upstream_server_error",
      );
      return;
    }

    if (summary.sawModelNotFound && !summary.sawRequestError) {
      sendOpenAiError(
        reply,
        404,
        `Model not found across available upstream providers: ${context.routedModel}`,
        "invalid_request_error",
        "model_not_found",
      );
      return;
    }

    if (summary.lastUpstreamAuthError) {
      sendOpenAiError(
        reply,
        summary.lastUpstreamAuthError.status,
        summary.lastUpstreamAuthError.message ?? "Upstream rejected the request due to authentication/authorization.",
        "invalid_request_error",
        "upstream_auth_error",
      );
      return;
    }

    const message = summary.sawRequestError
      ? "All upstream attempts failed due to network/transport errors."
      : "Upstream rejected the request with no successful fallback.";

    sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  });
}
