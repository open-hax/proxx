import type { FastifyReply } from "fastify";

import { kernels } from "../cljs-kernels.js";
import {
  type BuildPayloadResult,
  selectionFacts,
  type LocalAttemptContext,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type ProviderStrategy,
  type StrategyRequestContext,
  type UpstreamMode,
} from "./shared.js";

/*
 * How a strategy answers an upstream response (which reply the response earns,
 * the frames the client sees, the stream plumbing) lives in CLJS:
 * proxx.strategy.reply decides, proxx.http.reply spells the frames out,
 * proxx.runtime.provider-reply / proxx.runtime.reply do the I/O. The class keeps
 * the stable entry points and names its registry id.
 */
export abstract class BaseProviderStrategy implements ProviderStrategy {
  public abstract readonly mode: UpstreamMode;
  public abstract readonly isLocal: boolean;

  /** Id of this strategy's entry in the strategy registry (78-strategy-registry.edn). */
  public abstract readonly registryId: string;

  /** Whether the registry's predicates accept this request. */
  public matches(context: StrategyRequestContext): boolean {
    return kernels.strategyMatches(this.registryId, selectionFacts(context), context.config?.cljsPolicyManifestPath);
  }

  public abstract getUpstreamPath(context: StrategyRequestContext): string;

  public abstract buildPayload(context: StrategyRequestContext): BuildPayloadResult;

  public applyRequestHeaders(_headers: Headers, _context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    // default no-op
  }

  public async handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    return kernels.handleProviderAttempt(this.registryId, reply, response, context);
  }

  public async handleLocalAttempt(reply: FastifyReply, response: Response, context: LocalAttemptContext): Promise<void> {
    await kernels.handleLocalAttempt(this.registryId, reply, response, context);
  }

  protected async handleStandardProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome> {
    return kernels.handleStandardProviderAttempt(reply, upstreamResponse, context);
  }

  protected async handleStandardLocalAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: LocalAttemptContext
  ): Promise<void> {
    await kernels.handleStandardLocalAttempt(reply, upstreamResponse, context);
  }
}

/** Strategies whose OK JSON body is translated to a chat completion (the translation is chosen by registry id in CLJS). */
export abstract class TransformedJsonProviderStrategy extends BaseProviderStrategy {}
