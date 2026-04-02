import type { FastifyReply } from "fastify";

import type { KeyPool } from "./key-pool.js";
import type { ProviderRoute } from "./provider-routing.js";
import type { ProviderFallbackExecutionResult, ProviderAvailabilitySummary } from "./provider-strategy.js";
import { minMsUntilAnyProviderKeyReady } from "./provider-routing.js";
import { sendOpenAiError } from "./provider-utils.js";

export interface RoutingOutcomeDeps {
  readonly keyPool: KeyPool;
}

export interface RoutingOutcomeInput {
  readonly keyPool: KeyPool;
  readonly reply: FastifyReply;
  readonly execution: ProviderFallbackExecutionResult;
  readonly availability: ProviderAvailabilitySummary;
  readonly providerRoutes: readonly ProviderRoute[];
  readonly strategyMode: string;
  readonly routedModel: string;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  readonly logPrefix?: string;
}

/**
 * Handles the error outcome after executeProviderRoutingPlan returns with handled=false.
 * Sends an appropriate error response based on the execution summary.
 * Returns true if a response was sent, false if the caller should continue (e.g. try fallback).
 */
export async function handleRoutingOutcome(input: RoutingOutcomeInput): Promise<boolean> {
  const { keyPool, reply, execution, availability, providerRoutes, strategyMode, routedModel, log, logPrefix } = input;
  const prefix = logPrefix ? `${logPrefix}: ` : "";

  if (execution.candidateCount === 0) {
    const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
    if (retryInMs > 0) {
      reply.header("retry-after", Math.ceil(retryInMs / 1000));
    }

    if (!availability.sawConfiguredProvider) {
      sendOpenAiError(reply, 500, "Proxy is missing upstream account configuration", "server_error", "keys_unavailable");
      return true;
    }

    sendOpenAiError(
      reply,
      429,
      "All upstream accounts are currently rate-limited. Retry after the cooldown window.",
      "rate_limit_error",
      "all_keys_rate_limited",
    );
    return true;
  }

  const { summary } = execution;

  if (summary.sawUpstreamInvalidRequest) {
    log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategyMode }, `${prefix}all attempts exhausted due to upstream invalid-request responses`);
    sendOpenAiError(
      reply,
      400,
      "No upstream account accepted the request payload. Check model availability and request parameters.",
      "invalid_request_error",
      "upstream_rejected_request",
    );
    return true;
  }

  if (summary.sawRateLimit) {
    const retryInMs = await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes);
    if (retryInMs > 0) {
      reply.header("retry-after", Math.ceil(retryInMs / 1000));
    }

    log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategyMode }, `${prefix}all attempts exhausted due to upstream rate limits`);
    sendOpenAiError(
      reply,
      429,
      "No upstream account succeeded. Accounts may be rate-limited, quota-exhausted, or have outstanding balances.",
      "rate_limit_error",
      "no_available_key",
    );
    return true;
  }

  if (summary.sawUpstreamServerError) {
    log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategyMode }, `${prefix}all attempts exhausted due to upstream server errors`);
    sendOpenAiError(
      reply,
      502,
      "Upstream returned transient server errors across all available accounts.",
      "server_error",
      "upstream_server_error",
    );
    return true;
  }

  if (summary.sawModelNotFound && !summary.sawRequestError) {
    log.warn({ providerRoutes, attempts: summary.attempts, upstreamMode: strategyMode }, `${prefix}all attempts exhausted due to model-not-found responses`);
    sendOpenAiError(
      reply,
      404,
      `Model not found across available upstream providers: ${routedModel}`,
      "invalid_request_error",
      "model_not_found",
    );
    return true;
  }

  if (summary.lastUpstreamAuthError) {
    sendOpenAiError(
      reply,
      summary.lastUpstreamAuthError.status,
      summary.lastUpstreamAuthError.message ?? "Upstream rejected the request due to authentication/authorization.",
      "invalid_request_error",
      "upstream_auth_error",
    );
    return true;
  }

  const message = summary.sawRequestError
    ? "All upstream attempts failed due to network/transport errors."
    : "Upstream rejected the request with no successful fallback.";

  log.error({ providerRoutes, attempts: summary.attempts, upstreamMode: strategyMode, sawRequestError: summary.sawRequestError }, `${prefix}all upstream attempts exhausted`);
  sendOpenAiError(reply, 502, message, "server_error", "upstream_unavailable");
  return true;
}
