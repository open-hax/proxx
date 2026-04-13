import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { joinUrl } from "../lib/request-utils.js";
import { tenantProviderAllowed } from "../lib/tenant-policy-helpers.js";
import { buildForwardHeaders } from "../lib/proxy.js";
import {
  nativeEmbedToOpenAiRequest,
  nativeEmbedResponseToOpenAiEmbeddings,
} from "../lib/ollama-native.js";
import {
  selectProviderStrategy,
} from "../lib/provider-strategy.js";
import {
  filterTenantProviderRoutes,
} from "../lib/tenant-policy-helpers.js";
import { isAutoModel } from "../lib/auto-model-selector.js";
import { isRecord, sendOpenAiError, toErrorMessage, fetchWithResponseTimeout } from "../lib/provider-utils.js";

export function registerEmbeddingsRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/embeddings", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const model = typeof request.body.model === "string" ? request.body.model : "";
    if (isAutoModel(model)) {
      sendOpenAiError(reply, 400, "Auto models are not supported for embeddings requests.", "invalid_request_error", "model_not_supported");
      return;
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    if (!tenantProviderAllowed(tenantSettings, "ollama")) {
      sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
      return;
    }

    const routingState = selectProviderStrategy(
      deps.config,
      request.headers,
      {
        model,
        messages: [{ role: "user", content: "embed" }],
        stream: false,
      },
      model,
      model,
      (request as { readonly openHaxAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly tenantId?: string; readonly keyId?: string; readonly subject?: string } }).openHaxAuth,
    ).context;

    const routedModel = routingState.routedModel;
    const upstreamUrl = joinUrl(deps.config.ollamaBaseUrl, "/api/embed");
    const embedBody = nativeEmbedToOpenAiRequest({
      ...request.body,
      model: routedModel,
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
        method: "POST",
        headers: buildForwardHeaders(request.headers),
        body: JSON.stringify({
          model: embedBody.model,
          input: embedBody.input,
        }),
      }, deps.config.requestTimeoutMs);
    } catch (error) {
      sendOpenAiError(
        reply,
        502,
        `Embedding upstream request failed: ${toErrorMessage(error)}`,
        "server_error",
        "embedding_upstream_unavailable"
      );
      return;
    }

    if (!upstreamResponse.ok) {
      sendOpenAiError(
        reply,
        upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
        `Embedding upstream rejected the request: ${await upstreamResponse.text()}`,
        upstreamResponse.status >= 500 ? "server_error" : "invalid_request_error",
        "embedding_upstream_error"
      );
      return;
    }

    const upstreamJson = await upstreamResponse.json() as Record<string, unknown>;
    reply.send(nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, embedBody.model));
  });
}
