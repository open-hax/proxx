import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { joinUrl } from "../lib/http/index.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { buildForwardHeaders } from "../lib/proxy.js";
import {
  nativeEmbedToOpenAiRequest,
  nativeEmbedResponseToOpenAiEmbeddings,
  nativeEmbedToOllamaRequest,
} from "../lib/ollama-native.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import { isRecord, OpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { fetchWithResponseTimeout } from "../lib/http/index.js";
import { ensureNativeOllamaEmbedContextFits } from "../lib/ollama-context.js";
import { isOpenAiCompatEmbedProvider } from "../lib/provider-strategy/strategies/embeddings.js";
import { normalizeLlamacppModelName } from "../lib/provider-strategy/strategies/llamacpp.js";
import { filterDeclaredProviderRoutes, getDeclaredProviderRoutes, hasModelPrefix, stripModelPrefix } from "../lib/provider-routing.js";

function openAiRouteError(statusCode: number, message: string, type: string, code: string, meta?: Record<string, unknown>, cause?: unknown): OpenAiHttpError {
  return new OpenAiHttpError({ statusCode, message, type, code, meta, cause });
}

function summarizeEmbeddingInput(
  input: string | readonly string[],
): { readonly itemCount: number; readonly totalChars: number } {
  if (typeof input === "string") {
    return { itemCount: input.length > 0 ? 1 : 0, totalChars: input.length };
  }
  return {
    itemCount: input.length,
    totalChars: input.reduce((sum, entry) => sum + entry.length, 0),
  };
}

export function registerEmbeddingsRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/embeddings", async (request, reply) => {
    if (!isRecord(request.body)) {
      throw openAiRouteError(400, "Request body must be a JSON object", "invalid_request_error", "invalid_body");
    }

    const model = typeof request.body.model === "string" ? request.body.model : "";
    if (model.toLowerCase().startsWith("auto:")) {
      throw openAiRouteError(400, "Auto models are not supported for embeddings requests.", "invalid_request_error", "model_not_supported", { requestedModel: model });
    }

    const explicitlyLlamaCpp = hasModelPrefix(model, deps.config.llamacppModelPrefixes ?? []);
    const explicitlyOllama = !explicitlyLlamaCpp && hasModelPrefix(model, deps.config.ollamaModelPrefixes);

    const proxySettings = await deps.proxySettingsStore.getForTenant(
      (request.openHaxAuth?.tenantId) ?? DEFAULT_TENANT_ID,
    );

    // Use the full model routing pipeline so catalog, aliases, and tenant policy
    // are all honoured — same as chat completions.
    const modelRouting = await resolveModelRouting(
      {
        config: deps.config,
        proxySettings,
        providerCatalogStore: deps.providerCatalogStore,
        requestLogStore: deps.requestLogStore,
      },
      request.body,
      reply,
      request.log,
    );
    if (!modelRouting) {
      return;
    }

    const { routingModelInput } = modelRouting;

    const routingModelWithoutProviderPrefix = explicitlyLlamaCpp
      ? stripModelPrefix(routingModelInput, deps.config.llamacppModelPrefixes ?? [])
      : explicitlyOllama
        ? stripModelPrefix(routingModelInput, deps.config.ollamaModelPrefixes)
        : routingModelInput;

    const runtime = getActiveCljsRuntime();
    if (deps.config.cljsPolicyAuthoritative === true && !runtime) {
      throw openAiRouteError(503, "CLJS policy runtime is required for embeddings routing.", "server_error", "cljs_policy_runtime_unavailable", { requestedModel: model });
    }

    const declaredRoutes = getDeclaredProviderRoutes(deps.config);
    const selectedRoutes = filterDeclaredProviderRoutes(deps.config.cljsPolicyManifestPath, {
      config: deps.config,
      modelId: routingModelWithoutProviderPrefix,
      requestKind: "embeddings",
      tenantSettings: proxySettings,
      providerRoutes: declaredRoutes,
    }).providerRoutes;
    if (selectedRoutes.length === 0) {
      throw openAiRouteError(403, "No allowed embedding provider is available for this model.", "invalid_request_error", "provider_not_allowed", { routedModel: routingModelWithoutProviderPrefix });
    }

    for (const candidate of selectedRoutes) {
      const candidateId = candidate.providerId;
      const candidateIsOllama = !isOpenAiCompatEmbedProvider(candidateId);

      const candidateModel = candidateIsOllama
        ? routingModelWithoutProviderPrefix
        : normalizeLlamacppModelName(routingModelWithoutProviderPrefix);
      const candidateEmbedBody = nativeEmbedToOpenAiRequest({ ...request.body, model: candidateModel });
      const inputSummary = summarizeEmbeddingInput(candidateEmbedBody.input);
      if (inputSummary.itemCount > deps.config.embedMaxBatchItems) {
        throw openAiRouteError(
          400,
          `Embedding batch is too large. Received ${inputSummary.itemCount} items, maximum: ${deps.config.embedMaxBatchItems}.`,
          "invalid_request_error",
          "embed_batch_too_large",
          { itemCount: inputSummary.itemCount, maxItems: deps.config.embedMaxBatchItems },
        );
      }
      if (inputSummary.totalChars > deps.config.embedMaxInputChars) {
        throw openAiRouteError(
          400,
          `Embedding input is too large. Received ${inputSummary.totalChars} chars, maximum: ${deps.config.embedMaxInputChars}.`,
          "invalid_request_error",
          "embed_input_too_large",
          { totalChars: inputSummary.totalChars, maxChars: deps.config.embedMaxInputChars },
        );
      }

      const embedBudget = candidateIsOllama
        ? await runCljsQueued(
            deps.config.cljsPolicyManifestPath,
            { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": candidateId, "request-kind": "embeddings" },
            async (controller) => await ensureNativeOllamaEmbedContextFits(
              deps.config.ollamaBaseUrl,
              { model: candidateModel, input: candidateEmbedBody.input },
              Math.min(deps.config.requestTimeoutMs, 30_000),
              controller.signal,
            ),
          )
        : undefined;
      const maxContextTokens = Math.min(
        deps.config.embedMaxContextTokens,
        embedBudget?.contextLength ?? deps.config.embedMaxContextTokens,
      );
      if (embedBudget && embedBudget.estimatedInputTokens > maxContextTokens) {
        throw openAiRouteError(
          400,
          `Embedding request exceeds model context window for ${embedBudget.model}. ` +
            `Estimated: ${embedBudget.estimatedInputTokens} tokens, maximum: ${maxContextTokens}.`,
          "invalid_request_error",
          "embed_context_overflow",
          { model: embedBudget.model, estimatedInputTokens: embedBudget.estimatedInputTokens, maxContextTokens },
        );
      }

      const autoNumCtx = embedBudget && embedBudget.requiredContextTokens > embedBudget.availableContextTokens
        ? Math.min(maxContextTokens, embedBudget.recommendedNumCtx)
        : undefined;
      let upstreamResponse: Response;
      try {
        if (candidateIsOllama) {
          const upstreamBody = nativeEmbedToOllamaRequest(
            { ...request.body, model: candidateModel },
            autoNumCtx ?? embedBudget?.availableContextTokens,
          );
          upstreamResponse = await runCljsQueued(
            deps.config.cljsPolicyManifestPath,
            { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": candidateId, "request-kind": "embeddings" },
            async (controller) => await fetchWithResponseTimeout(
              joinUrl(deps.config.ollamaBaseUrl, "/api/embed"),
              { method: "POST", headers: buildForwardHeaders(request.headers), body: JSON.stringify(upstreamBody), signal: controller.signal },
              deps.config.requestTimeoutMs,
            ),
          );
        } else {
          const candidateBaseUrl = deps.config.upstreamProviderBaseUrls[candidateId] ?? candidate.baseUrl ?? "";
          if (!candidateBaseUrl) {
            request.log.warn({ providerId: candidateId }, "no base URL for provider, skipping");
            continue;
          }
          upstreamResponse = await runCljsQueued(
            deps.config.cljsPolicyManifestPath,
            { "tenant-id": request.openHaxAuth?.tenantId ?? "default", "provider-id": candidateId, "request-kind": "embeddings" },
            async (controller) => await fetchWithResponseTimeout(
              joinUrl(candidateBaseUrl, "/v1/embeddings"),
              { method: "POST", headers: buildForwardHeaders(request.headers), body: JSON.stringify({ ...candidateEmbedBody, model: candidateModel }), signal: controller.signal },
              deps.config.requestTimeoutMs,
            ),
          );
        }
      } catch (error) {
        if (sendQueueError(reply, error)) {
          return;
        }
        request.log.warn({ providerId: candidateId, err: toErrorMessage(error) }, "embedding provider fetch failed, will try next");
        continue;
      }

      if (!upstreamResponse.ok) {
        const responseText = await upstreamResponse.text();
        if (upstreamResponse.status >= 500) {
          request.log.warn({ providerId: candidateId, status: upstreamResponse.status, response: responseText.slice(0, 200) }, "embedding provider 5xx, will try next");
          continue;
        }
        throw openAiRouteError(
          upstreamResponse.status,
          `Embedding upstream rejected the request: ${responseText}`,
          "invalid_request_error",
          "embedding_upstream_error",
          { providerId: candidateId, status: upstreamResponse.status },
        );
      }

      const upstreamJson = await upstreamResponse.json() as Record<string, unknown>;
      reply.send(
        candidateIsOllama
          ? nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, candidateEmbedBody.model)
          : { ...upstreamJson, model: candidateEmbedBody.model },
      );
      return;
    }

    throw openAiRouteError(
      502,
      "All embedding providers failed for this model.",
      "server_error",
      "embedding_upstream_unavailable",
      { requestedModel: model, routedModel: routingModelWithoutProviderPrefix },
    );
  });
}
