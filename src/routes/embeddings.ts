import type { FastifyInstance } from "fastify";

import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { tenantProviderAllowed } from "../lib/tenant-policy-helpers.js";
import { buildForwardHeaders } from "../lib/proxy.js";
import { nativeEmbedResponseToOpenAiEmbeddings, nativeEmbedToOllamaRequest } from "../lib/ollama-native.js";
import { selectProviderStrategy } from "../lib/provider-strategy.js";
import { isAutoModel } from "../lib/auto-model-selector.js";
import { fetchOllamaModelContextLength } from "../lib/ollama-context.js";
import { joinUrl } from "../lib/request-utils.js";
import { isRecord, sendOpenAiError, toErrorMessage, fetchWithResponseTimeout } from "../lib/provider-utils.js";

function embedInputItemCount(input: unknown): number {
  if (typeof input === "string") {
    return 1;
  }
  if (Array.isArray(input)) {
    return input.filter((entry) => typeof entry === "string").length;
  }
  return 0;
}

function embedInputCharCount(input: unknown): number {
  if (typeof input === "string") {
    return input.length;
  }
  if (Array.isArray(input)) {
    return input.reduce((total, entry) => total + (typeof entry === "string" ? entry.length : 0), 0);
  }
  return 0;
}

export function registerEmbeddingsRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/embeddings", async (request, reply) => {
    if (!isRecord(request.body)) {
      sendOpenAiError(reply, 400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
      return;
    }

    const model = typeof request.body.model === "string" ? request.body.model : "";
    if (isAutoModel(model)) {
      sendOpenAiError(
        reply,
        400,
        "Auto models are not supported for embeddings requests.",
        "invalid_request_error",
        "model_not_supported",
      );
      return;
    }

    const itemCount = embedInputItemCount(request.body.input);
    if (itemCount > deps.config.embedMaxBatchItems) {
      sendOpenAiError(
        reply,
        400,
        `Embedding batch size exceeds limit: ${itemCount} items (max ${deps.config.embedMaxBatchItems}).`,
        "invalid_request_error",
        "embed_batch_too_large",
      );
      return;
    }

    const charCount = embedInputCharCount(request.body.input);
    if (charCount > deps.config.embedMaxInputChars) {
      sendOpenAiError(
        reply,
        400,
        `Embedding input exceeds limit: ${charCount} characters (max ${deps.config.embedMaxInputChars}).`,
        "invalid_request_error",
        "embed_input_too_large",
      );
      return;
    }

    const tenantSettings = await deps.proxySettingsStore.getForTenant(
      ((request as { readonly openHaxAuth?: { readonly tenantId?: string } }).openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );
    if (!tenantProviderAllowed(tenantSettings, "ollama")) {
      sendOpenAiError(reply, 403, "Provider is disabled for this tenant: ollama", "invalid_request_error", "provider_not_allowed");
      return;
    }

    // We reuse the routing logic to normalize/prefix-strip models the same way chat requests do.
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

    const defaultNumCtx = await fetchOllamaModelContextLength(
      deps.config.ollamaBaseUrl,
      routedModel,
      Math.min(30_000, deps.config.requestTimeoutMs),
    );

    const upstreamPayload = nativeEmbedToOllamaRequest(
      {
        ...request.body,
        model: routedModel,
      },
      defaultNumCtx ?? undefined,
    );

    const upstreamUrl = joinUrl(deps.config.ollamaBaseUrl, "/api/embed");

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResponseTimeout(
        upstreamUrl,
        {
          method: "POST",
          headers: buildForwardHeaders(request.headers),
          body: JSON.stringify(upstreamPayload),
        },
        deps.config.requestTimeoutMs,
      );
    } catch (error) {
      sendOpenAiError(
        reply,
        502,
        `Embedding upstream request failed: ${toErrorMessage(error)}`,
        "server_error",
        "embedding_upstream_unavailable",
      );
      return;
    }

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      sendOpenAiError(
        reply,
        upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
        `Embedding upstream rejected the request: ${errorText}`,
        upstreamResponse.status >= 500 ? "server_error" : "invalid_request_error",
        "embedding_upstream_error",
      );
      return;
    }

    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch (error) {
      sendOpenAiError(
        reply,
        502,
        `Failed to parse embeddings payload: ${toErrorMessage(error)}`,
        "server_error",
        "embedding_parse_failed",
      );
      return;
    }

    if (!isRecord(upstreamJson)) {
      sendOpenAiError(
        reply,
        502,
        "Embeddings upstream returned an unexpected payload.",
        "server_error",
        "embedding_upstream_invalid",
      );
      return;
    }

    reply.send(nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, routedModel));
  });
}
