import { extractPromptCacheKey } from "../lib/openai/index.js";
import { OpenAiHttpError, isOpenAiHttpError, runCljsQueued, sendQueueError } from "../lib/provider-utils.js";
import { resolveModelRouting } from "../lib/model-routing-pipeline.js";
import {
  selectProviderStrategy,
  executeProviderRoutingPlan,
  inspectProviderAvailability,
  executeLocalStrategy,
} from "../lib/provider-strategy.js";
import { selectExecutionStrategyForProviderRoutes } from "../lib/provider-strategy/registry.js";
import {
  filterDeclaredProviderRoutes,
  filterImagesApiRoutes,
  filterResponsesApiRoutes,
  getDeclaredProviderRoutes,
} from "../lib/provider-routing.js";
import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { toErrorMessage } from "../lib/errors/index.js";
import { handleRoutingOutcome } from "../lib/routing-outcome-handler.js";
import { requestHasExplicitNumCtx } from "../lib/ollama-compat.js";
import { ensureOllamaContextFits } from "../lib/ollama-context.js";
import { executeBridgeRequestRouting } from "../lib/federation/bridge-routing.js";
import { DEFAULT_TENANT_ID } from "../lib/tenant-api-key.js";
import { resolveCatalogAndAlias } from "../lib/catalog-alias-resolver.js";
import { resolvableConcreteModelIdsForProviders } from "../lib/catalog-resolution.js";
import { hashPromptCacheKey, summarizeResponsesRequestBody } from "../lib/openai/index.js";
import { copyInjectedResponseHeaders } from "../lib/request-utils.js";
import {
  chatCompletionToSse,
  chatCompletionEventStreamToResponsesEventStream,
  chatCompletionToResponsesResponse,
  responsesRequestToChatRequest,
  shouldUseResponsesUpstream,
} from "../lib/responses-compat.js";

/**
 * Host collaborators the CLJS /v1 routes (proxx.runtime.routes.v1) sequence:
 * strategy selection and execution, route filters, the request queue,
 * federation/bridge routing and the reply-owning outcome handler. The routes'
 * decisions live in CLJS (proxx.http.v1).
 */
export function v1RouteCollaborators(): Record<string, unknown> {
  return {
    defaultTenantId: DEFAULT_TENANT_ID,
    resolveModelRouting,
    resolveCatalogAndAlias,
    selectProviderStrategy,
    selectExecutionStrategyForProviderRoutes,
    executeProviderRoutingPlan,
    inspectProviderAvailability,
    executeLocalStrategy,
    executeBridgeRequestRouting,
    handleRoutingOutcome,
    getDeclaredProviderRoutes,
    filterDeclaredProviderRoutes,
    filterImagesApiRoutes,
    filterResponsesApiRoutes,
    ensureOllamaContextFits,
    requestHasExplicitNumCtx,
    extractPromptCacheKey,
    hashPromptCacheKey,
    summarizeResponsesRequestBody,
    resolvableConcreteModelIdsForProviders,
    shouldUseResponsesUpstream,
    responsesRequestToChatRequest,
    chatCompletionToSse,
    chatCompletionEventStreamToResponsesEventStream,
    chatCompletionToResponsesResponse,
    copyInjectedResponseHeaders,
    runCljsQueued,
    sendQueueError,
    toErrorMessage,
    getActiveCljsRuntime,
    isOpenAiHttpError,
    makeOpenAiHttpError: (input: ConstructorParameters<typeof OpenAiHttpError>[0]) => new OpenAiHttpError(input),
  };
}
