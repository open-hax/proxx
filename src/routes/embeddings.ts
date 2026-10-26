import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { joinUrl, fetchWithResponseTimeout } from "../lib/http/index.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import { OpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { ensureNativeOllamaEmbedContextFits } from "../lib/ollama-context.js";
import { isOpenAiCompatEmbedProvider } from "../lib/provider-strategy/strategies/embeddings.js";
import { normalizeLlamacppModelName } from "../lib/provider-strategy/strategies/llamacpp.js";
import { filterDeclaredProviderRoutes, getDeclaredProviderRoutes, stripModelPrefix } from "../lib/provider-routing.js";

/**
 * The host collaborators of POST /v1/embeddings. The pipeline (provider hints,
 * size limits, context budget, upstream request per candidate, verdicts) lives
 * in CLJS (proxx.http.embeddings, proxx.runtime.routes.embeddings).
 */
export function embeddingsRouteCollaborators(): Record<string, unknown> {
  return {
    defaultTenantId: DEFAULT_TENANT_ID,
    resolveModelRouting,
    getDeclaredProviderRoutes,
    filterDeclaredProviderRoutes,
    stripModelPrefix,
    isOpenAiCompatEmbedProvider: (providerId: string) => isOpenAiCompatEmbedProvider(providerId),
    normalizeLlamacppModelName,
    ensureNativeOllamaEmbedContextFits,
    runCljsQueued,
    sendQueueError,
    joinUrl,
    fetchWithResponseTimeout,
    toErrorMessage,
    getActiveCljsRuntime,
    makeOpenAiHttpError: (input: ConstructorParameters<typeof OpenAiHttpError>[0]) => new OpenAiHttpError(input),
  };
}
