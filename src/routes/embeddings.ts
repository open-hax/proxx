import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { joinUrl } from "../lib/http/index.js";
import { tenantProviderAllowed } from "../lib/policy/engine/index.js";
import { buildForwardHeaders } from "../lib/proxy.js";
import {
  nativeEmbedToOpenAiRequest,
  nativeEmbedResponseToOpenAiEmbeddings,
  nativeEmbedToOllamaRequest,
} from "../lib/ollama-native.js";
import {
  selectProviderStrategy,
} from "../lib/provider-strategy.js";
import { isAutoModel } from "../lib/auto-model-selector.js";
import { isRecord, sendOpenAiError, toErrorMessage } from "../lib/provider-utils.js";
import { fetchWithResponseTimeout } from "../lib/http/index.js";
import { ensureNativeOllamaEmbedContextFits } from "../lib/ollama-context.js";

function summarizeEmbeddingInput(input: string | readonly string[]): { readonly itemCount: number; readonly totalChars: number } {
  if (typeof input === "string") {
    return {
      itemCount: input.length > 0 ? 1 : 0,
      totalChars: input.length,
    };
  }

  return {
    itemCount: input.length,
    totalChars: input.reduce((sum, entry) => sum + entry.length, 0),
  };
}

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
      (request.openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
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
      request.openHaxAuth ?? undefined,
    ).context;

    const routedModel = routingState.routedModel;
    const upstreamUrl = joinUrl(deps.config.ollamaBaseUrl, "/api/embed");
    const embedBody = nativeEmbedToOpenAiRequest({
      ...request.body,
      model: routedModel,
    });
    const inputSummary = summarizeEmbeddingInput(embedBody.input);

    if (inputSummary.itemCount > deps.config.embedMaxBatchItems) {
      sendOpenAiError(
        reply,
        400,
        `Embedding batch is too large. Received ${inputSummary.itemCount} input items, maximum: ${deps.config.embedMaxBatchItems}. Split the request into smaller batches.`,
        "invalid_request_error",
        "embed_batch_too_large",
      );
      return;
    }

    if (inputSummary.totalChars > deps.config.embedMaxInputChars) {
      sendOpenAiError(
        reply,
        400,
        `Embedding input is too large. Received ${inputSummary.totalChars} characters, maximum: ${deps.config.embedMaxInputChars}. Split the request into smaller chunks.`,
        "invalid_request_error",
        "embed_input_too_large",
      );
      return;
    }

    const embedBudget = await ensureNativeOllamaEmbedContextFits(
      deps.config.ollamaBaseUrl,
      { model: routedModel, input: embedBody.input },
      Math.min(deps.config.requestTimeoutMs, 30_000),
    );

    const maxContextTokens = Math.min(
      deps.config.embedMaxContextTokens,
      embedBudget?.contextLength ?? deps.config.embedMaxContextTokens,
    );

    if (embedBudget && embedBudget.estimatedInputTokens > maxContextTokens) {
      sendOpenAiError(
        reply,
        400,
        `Embedding request exceeds model context window for ${embedBudget.model}. Estimated input tokens: ${embedBudget.estimatedInputTokens}, maximum: ${maxContextTokens}. Reduce input size or split the document before embedding.`,
        "invalid_request_error",
        "embed_context_overflow",
      );
      return;
    }

    const autoNumCtx = embedBudget && embedBudget.requiredContextTokens > embedBudget.availableContextTokens
      ? Math.min(maxContextTokens, embedBudget.recommendedNumCtx)
      : undefined;

    const upstreamBody = nativeEmbedToOllamaRequest(
      {
        ...request.body,
        model: routedModel,
      },
      autoNumCtx ?? embedBudget?.availableContextTokens,
    );

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
        method: "POST",
        headers: buildForwardHeaders(request.headers),
        body: JSON.stringify(upstreamBody),
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
