import type { FastifyReply } from "fastify";

import type { KeyPool } from "./key-pool.js";
import type { ProviderRoute } from "./provider-routing.js";
import type { ProviderRoutingExecutionResult, ProviderAvailabilitySummary } from "./provider-strategy.js";
import { minMsUntilAnyProviderKeyReady } from "./provider-routing.js";
import { sendOpenAiError } from "./provider-utils.js";
import { kernels } from "./cljs-kernels.js";

export interface RoutingOutcomeDeps {
  readonly keyPool: KeyPool;
}

export interface RoutingOutcomeInput {
  readonly keyPool: KeyPool;
  readonly reply: FastifyReply;
  readonly execution: ProviderRoutingExecutionResult;
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
 * Returns true if a response was sent, false if the caller should continue (e.g. try routing).
 *
 * Which response to send is decided by the CLJS kernel `proxx.routing.outcome`; this
 * function only gathers the key-cooldown hint and sends the result.
 */
export async function handleRoutingOutcome(input: RoutingOutcomeInput): Promise<boolean> {
  const { keyPool, reply, execution, availability, providerRoutes, strategyMode, routedModel, log, logPrefix } = input;

  const outcome = kernels.classifyRoutingOutcome(execution, availability);
  const retryInMs = kernels.routingOutcomeNeedsRetryHint(outcome)
    ? await minMsUntilAnyProviderKeyReady(keyPool, providerRoutes)
    : 0;
  const response = kernels.routingOutcomeResponse(
    outcome,
    {
      routedModel,
      logPrefix,
      lastUpstreamError: execution.summary.lastUpstreamError,
      sawRequestError: execution.summary.sawRequestError,
    },
    retryInMs,
  );

  if (response.retryAfterSeconds !== undefined) {
    reply.header("retry-after", response.retryAfterSeconds);
  }
  if (response.log) {
    const fields = { providerRoutes, attempts: execution.summary.attempts, upstreamMode: strategyMode };
    if (response.log.level === "error") {
      log.error({ ...fields, sawRequestError: execution.summary.sawRequestError }, response.log.message);
    } else {
      log.warn(fields, response.log.message);
    }
  }
  sendOpenAiError(reply, response.status, response.message, response.type, response.code);
  return true;
}
