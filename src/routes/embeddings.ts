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
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import { isAutoModel } from "../lib/auto-model-selector.js";
import { isRecord, sendOpenAiError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { fetchWithResponseTimeout } from "../lib/http/index.js";
import { ensureNativeOllamaEmbedContextFits } from "../lib/ollama-context.js";
import { isOpenAiCompatEmbedProvider } from "../lib/provider-strategy/strategies/embeddings.js";
import { normalizeLlamacppModelName } from "../lib/provider-strategy/strategies/llamacpp.js";
import { hasModelPrefix } from "../lib/provider-routing.js";

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

/**
 * Resolve which provider serves a given model by scanning the live catalog.
 * Returns the first providerId whose discovered model list includes the model,
 * or undefined if not found (caller falls back to ollamaBaseUrl).
 */
function resolveEmbedProvider(
  resolvedCatalogBundle: import("../lib/provider-catalog.js").ResolvedCatalogWithPreferences | null,
  routedModel: string,
): string | undefined {
  if (!resolvedCatalogBundle) {
    return undefined;
  }
  // Normalize colon separators to hyphens to match llamacpp catalog format
  // (e.g. qwen3-embedding:0.6b -> qwen3-embedding-0.6b)
  const normalized = routedModel.trim().toLowerCase().replace(/:/g, "-");
  for (const [providerId, entry] of Object.entries(resolvedCatalogBundle.providerCatalogs)) {
    if (entry.modelIds.some((id) => id.trim().toLowerCase() === normalized)) {
      return providerId;
    }
  }
  return undefined;
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

    const explicitlyLlamaCpp = hasModelPrefix(model, deps.config.llamacppModelPrefixes ?? []);
    const explicitlyOllama = !explicitlyLlamaCpp && hasModelPrefix(model, deps.config.ollamaModelPrefixes);
    const requestProviderId = explicitlyLlamaCpp ? "llamacpp-embed" : explicitlyOllama ? "ollama" : undefined;

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

    const { routingModelInput, resolvedCatalogBundle } = modelRouting;

    // Resolve from catalog for fallback
    const catalogProviderId = resolveEmbedProvider(resolvedCatalogBundle, routingModelInput);

    // Override provider with explicitly specified provider from model prefix
    let routeProviderId: string;
    if (requestProviderId) {
      routeProviderId = requestProviderId;
    } else if (catalogProviderId) {
      routeProviderId = catalogProviderId;
    } else {
      routeProviderId = "ollama";
    }
    const isOllamaProvider = !isOpenAiCompatEmbedProvider(routeProviderId);

    if (!tenantProviderAllowed(proxySettings, isOllamaProvider ? "ollama" : routeProviderId)) {
      sendOpenAiError(
        reply, 403,
        `Provider is disabled for this tenant: ${routeProviderId}`,
        "invalid_request_error", "provider_not_allowed",
      );
      return;
    }

    // Normalize model name for the target provider.
    const routedModel = isOllamaProvider
      ? routingModelInput
      : normalizeLlamacppModelName(routingModelInput);

    const embedBody = nativeEmbedToOpenAiRequest({ ...request.body, model: routedModel });
    const inputSummary = summarizeEmbeddingInput(embedBody.input);

    if (inputSummary.itemCount > deps.config.embedMaxBatchItems) {
      sendOpenAiError(
        reply, 400,
        `Embedding batch is too large. Received ${inputSummary.itemCount} items, maximum: ${deps.config.embedMaxBatchItems}.`,
        "invalid_request_error", "embed_batch_too_large",
      );
      return;
    }

    if (inputSummary.totalChars > deps.config.embedMaxInputChars) {
      sendOpenAiError(
        reply, 400,
        `Embedding input is too large. Received ${inputSummary.totalChars} chars, maximum: ${deps.config.embedMaxInputChars}.`,
        "invalid_request_error", "embed_input_too_large",
      );
      return;
    }

    // Context-fit check is Ollama-specific (requires /api/show); skip for OpenAI-compat providers.
    const embedBudget = isOllamaProvider
      ? await ensureNativeOllamaEmbedContextFits(
          deps.config.ollamaBaseUrl,
          { model: routedModel, input: embedBody.input },
          Math.min(deps.config.requestTimeoutMs, 30_000),
        )
      : undefined;

    const maxContextTokens = Math.min(
      deps.config.embedMaxContextTokens,
      embedBudget?.contextLength ?? deps.config.embedMaxContextTokens,
    );

    if (embedBudget && embedBudget.estimatedInputTokens > maxContextTokens) {
      sendOpenAiError(
        reply, 400,
        `Embedding request exceeds model context window for ${embedBudget.model}. ` +
          `Estimated: ${embedBudget.estimatedInputTokens} tokens, maximum: ${maxContextTokens}.`,
        "invalid_request_error", "embed_context_overflow",
      );
      return;
    }

    const autoNumCtx = embedBudget && embedBudget.requiredContextTokens > embedBudget.availableContextTokens
      ? Math.min(maxContextTokens, embedBudget.recommendedNumCtx)
      : undefined;

    let upstreamResponse: Response;
    try {
      if (isOllamaProvider) {
        // Ollama native path: POST /api/embed
        const upstreamBody = nativeEmbedToOllamaRequest(
          { ...request.body, model: routedModel },
          autoNumCtx ?? embedBudget?.availableContextTokens,
        );
        upstreamResponse = await fetchWithResponseTimeout(
          joinUrl(deps.config.ollamaBaseUrl, "/api/embed"),
          { method: "POST", headers: buildForwardHeaders(request.headers), body: JSON.stringify(upstreamBody) },
          deps.config.requestTimeoutMs,
        );
      } else {
        // OpenAI-compat path: POST /v1/embeddings to the catalog-resolved provider.
        const providerBaseUrl = deps.config.upstreamProviderBaseUrls[routeProviderId] ?? "";
        if (!providerBaseUrl) {
          sendOpenAiError(
            reply, 502,
            `No base URL configured for embed provider: ${routeProviderId}`,
            "server_error", "embedding_upstream_unavailable",
          );
          return;
        }
        upstreamResponse = await fetchWithResponseTimeout(
          joinUrl(providerBaseUrl, "/v1/embeddings"),
          { method: "POST", headers: buildForwardHeaders(request.headers), body: JSON.stringify({ ...embedBody, model: routedModel }) },
          deps.config.requestTimeoutMs,
        );
      }
    } catch (error) {
      sendOpenAiError(
        reply, 502,
        `Embedding upstream request failed: ${toErrorMessage(error)}`,
        "server_error", "embedding_upstream_unavailable",
      );
      return;
    }

    if (!upstreamResponse.ok) {
      sendOpenAiError(
        reply,
        upstreamResponse.status >= 500 ? 502 : upstreamResponse.status,
        `Embedding upstream rejected the request: ${await upstreamResponse.text()}`,
        upstreamResponse.status >= 500 ? "server_error" : "invalid_request_error",
        "embedding_upstream_error",
      );
      return;
    }

    const upstreamJson = await upstreamResponse.json() as Record<string, unknown>;
    // Ollama returns its own format; OpenAI-compat providers already return OpenAI shape.
    reply.send(
      isOllamaProvider
        ? nativeEmbedResponseToOpenAiEmbeddings(upstreamJson, embedBody.model)
        : { ...upstreamJson, model: embedBody.model },
    );
  });
}
