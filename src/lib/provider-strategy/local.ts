import type { FastifyReply } from "fastify";

import { kernels } from "../cljs-kernels.js";
import { estimateRequestCost } from "../model-pricing.js";
import type { RequestLogStore } from "../request-log-store.js";
import type { BuildPayloadResult, ProviderStrategy, StrategyRequestContext } from "./shared.js";

/**
 * One request to the local Ollama upstream, answered through the strategy. The
 * attempt (headers, span, request log, usage, error reply) is CLJS
 * (proxx.runtime.attempt-executor); the pricing function is the host's.
 */
export async function executeLocalStrategy(
  strategy: ProviderStrategy,
  reply: FastifyReply,
  requestLogStore: RequestLogStore,
  context: StrategyRequestContext,
  payload: BuildPayloadResult,
  queueSignal?: AbortSignal,
): Promise<void> {
  await kernels.executeLocalStrategy(strategy, reply, requestLogStore, context, payload, queueSignal, { estimateRequestCost });
}
