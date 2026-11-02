import type { IncomingHttpHeaders } from "node:http";

import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "../config.js";
import type { ProviderCredential } from "../key-pool.js";
import type { RequestLogStore } from "../request-log-store.js";
import type { ResolvedRequestAuth } from "../request-auth.js";
import { kernels, type StrategySelectionFacts } from "../cljs-kernels.js";

/*
 * Decisions in this module (usage extraction, diagnostics fingerprints, service
 * tier selection, credential ordering and judgement) are pure CLJS kernels
 * (proxx.strategy.*); what remains is context plumbing and effects.
 */

function shouldRetrySameCredentialForServerError(status: number, manifestPath?: string): boolean {
  return kernels.shouldRetrySameCredentialForServerError(status, manifestPath);
}

function shouldCooldownCredentialOnAuthFailure(providerId: string, status: number, manifestPath?: string): boolean {
  return kernels.shouldCooldownCredentialOnAuthFailure(providerId, status, manifestPath);
}

/**
 * For static API keys, 402/403 means the key was disabled (permanent); the
 * per-provider exceptions and the cooldown are declared in
 * 77-upstream-attempt-policy.edn. OAuth accounts are excluded (they refresh).
 */
const PERMANENT_DISABLE_COOLDOWN_MS = kernels.permanentDisableCooldownMs();

function shouldPermanentlyDisableCredential(credential: ProviderCredential, status: number, manifestPath?: string): boolean {
  return kernels.shouldPermanentlyDisableCredential(credential, status, manifestPath);
}

function reorderCandidatesForAffinity<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: PreferredAffinity | undefined,
): T[] {
  return reorderCandidatesForAffinities(candidates, preferred ? [preferred] : []);
}

export function reorderCandidatesForAffinities<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: readonly { readonly providerId: string; readonly accountId: string }[],
): T[] {
  return kernels.reorderCandidatesForAffinities(candidates, preferred);
}

type UpstreamMode =
  | "chat_completions"
  | "responses"
  | "responses_passthrough"
  | "openai_responses_passthrough"
  | "images"
  | "gemini_chat"
  | "messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "ollama_chat"
  | "local_ollama_chat"
  | "embeddings"
  | "hf_embeddings"
  | "tei_embeddings"
  | "ovm_embeddings";

interface StrategyRequestContext {
  /** Provider id for which we're selecting an upstream strategy. */
  readonly routeProviderId?: string;
  readonly config: ProxyConfig;
  readonly clientHeaders: IncomingHttpHeaders;
  readonly requestBody: Record<string, unknown>;
  readonly requestAuth?: Pick<ResolvedRequestAuth, "kind" | "tenantId" | "keyId" | "subject">;
  readonly requestedModelInput: string;
  readonly routingModelInput: string;
  readonly routedModel: string;
  readonly explicitOllama: boolean;
  readonly openAiPrefixed: boolean;
  readonly factoryPrefixed: boolean;
  readonly localOllama: boolean;
  readonly clientWantsStream: boolean;
  readonly needsReasoningTrace: boolean;
  readonly upstreamAttemptTimeoutMs: number;
  readonly responsesPassthrough?: boolean;
  readonly imagesPassthrough?: boolean;
  readonly embeddingsPassthrough?: boolean;
  /** Strategy mode selected by the authoritative declarative policy, when available. */
  readonly policyPreferredStrategyMode?: UpstreamMode;
  /** Strategy modes selected by policy per provider route. */
  readonly policyPreferredStrategyModeByProvider?: Readonly<Record<string, UpstreamMode>>;
  /** Per-provider path overrides from CLJS contract routes, keyed by path kind (chat-completions, messages, responses, images-generations). */
  readonly providerPaths?: Readonly<Record<string, string>>;
}

interface ProviderAttemptContext extends StrategyRequestContext {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly account: ProviderCredential;
  readonly hasMoreCandidates: boolean;
  readonly attempt: number;
}

interface LocalAttemptContext extends StrategyRequestContext {
  readonly baseUrl: string;
}

interface ProviderAttemptOutcomeHandled {
  readonly kind: "handled";
}

interface ProviderAttemptOutcomeContinue {
  readonly kind: "continue";
  readonly rateLimit?: boolean;
  readonly requestError?: boolean;
  readonly upstreamServerError?: boolean;
  readonly upstreamInvalidRequest?: boolean;
  readonly upstreamErrorBody?: string;
  readonly modelNotFound?: boolean;
  readonly modelNotSupportedForAccount?: boolean;
  readonly upstreamAuthError?: {
    readonly status: number;
    readonly message?: string;
  };
}

type ProviderAttemptOutcome = ProviderAttemptOutcomeHandled | ProviderAttemptOutcomeContinue;

interface RoutingAccumulator {
  sawRateLimit: boolean;
  sawRequestError: boolean;
  sawUpstreamServerError: boolean;
  sawUpstreamInvalidRequest: boolean;
  lastUpstreamError?: { status: number; body: string; providerId?: string };
  sawModelNotFound: boolean;
  sawModelNotSupportedForAccount: boolean;
  attempts: number;
  lastUpstreamAuthError?: {
    readonly status: number;
    readonly message?: string;
  };
}

export interface ProviderRoutingExecutionResult {
  readonly handled: boolean;
  readonly candidateCount: number;
  readonly summary: RoutingAccumulator;
}

interface PreferredAffinity {
  readonly providerId: string;
  readonly accountId: string;
}

export interface ProviderAvailabilitySummary {
  readonly sawConfiguredProvider: boolean;
  readonly sawOnlyDisabledProviders: boolean;
  readonly prompt_cache_key?: string;
}

interface BuildPayloadResult {
  readonly upstreamPayload: Record<string, unknown>;
  readonly bodyText: string;
  readonly serviceTier?: string;
  readonly serviceTierSource: "fast_mode" | "explicit" | "none";
}

function providerAccountsForRequest(
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
): ProviderCredential[] {
  return kernels.providerAccountsForRequest(accounts, providerId, routedModel);
}

function reorderAccountsForLatency(
  requestLogStore: RequestLogStore,
  providerId: string,
  accounts: readonly ProviderCredential[],
  routedModel: string,
  upstreamMode: string,
): ProviderCredential[] {
  return kernels.reorderAccountsForLatency(requestLogStore, providerId, accounts, routedModel, upstreamMode);
}

export interface UsageCounts {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
}

interface ProviderStrategy {
  readonly mode: UpstreamMode;
  readonly isLocal: boolean;
  matches(context: StrategyRequestContext): boolean;
  getUpstreamPath(context: StrategyRequestContext): string;
  buildPayload(context: StrategyRequestContext): BuildPayloadResult;
  applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, payload: Record<string, unknown>): void;
  handleProviderAttempt(
    reply: FastifyReply,
    response: Response,
    context: ProviderAttemptContext
  ): Promise<ProviderAttemptOutcome>;
  handleLocalAttempt(reply: FastifyReply, response: Response, context: LocalAttemptContext): Promise<void>;
}

/**
 * Optional interface for strategies that want to bypass the standard HTTP fetch
 * and handle the upstream request directly (e.g., using an SDK).
 */
export interface DirectExecutionProviderStrategy extends ProviderStrategy {
  executeDirect(
    reply: FastifyReply,
    context: ProviderAttemptContext,
    payload: Record<string, unknown>,
  ): Promise<ProviderAttemptOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The request facts the strategy registry's predicates read (proxx.runtime.strategies/selection-facts). */
function selectionFacts(context: StrategyRequestContext, policyPreferredMode?: string): StrategySelectionFacts {
  return kernels.selectionFacts(context, policyPreferredMode);
}

export function extractUsageCountsFromSseText(
  streamText: string,
  mode: UpstreamMode,
  routedModel: string,
): UsageCounts {
  return kernels.extractUsageCountsFromSseText(streamText, mode, routedModel);
}

export type {
  UpstreamMode,
  StrategyRequestContext,
  ProviderAttemptContext,
  LocalAttemptContext,
  ProviderAttemptOutcome,
  RoutingAccumulator,
  PreferredAffinity,
  BuildPayloadResult,
  ProviderStrategy,
}
export {
  PERMANENT_DISABLE_COOLDOWN_MS,
  shouldRetrySameCredentialForServerError,
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  reorderCandidatesForAffinity,
  providerAccountsForRequest,
  reorderAccountsForLatency,
  isRecord,
  selectionFacts,
}
