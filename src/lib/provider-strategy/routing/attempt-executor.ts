import type { FastifyReply } from "fastify";

import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { EventStore } from "../../db/event-store.js";
import type { ProviderCredential } from "../../key-pool.js";
import type { IPromptAffinityStore } from "../../db/sql-prompt-affinity-store.js";
import type { ProviderRoutePheromoneStore } from "../../provider-route-pheromone-store.js";
import type { RequestLogStore } from "../../request-log-store.js";
import type { QuotaMonitor } from "../../quota-monitor.js";
import {
  buildUpstreamHeadersForCredential,
  classifyRateLimitKind,
  detectOllamaLimitKind,
  extractRateLimitCooldownMs,
  isRateLimitResponse,
} from "../../proxy.js";
import {
  responsesEventStreamToErrorPayload,
} from "../../responses-compat.js";
import type { ProviderRoute } from "../../provider-routing.js";
import { fetchWithResponseTimeout } from "../../http/index.js";
import {
  responseIndicatesQuotaError,
  summarizeUpstreamError,
  toErrorMessage,
} from "../../errors/index.js";
import { getTelemetry } from "../../telemetry/otel.js";
import { selectRemoteProviderStrategyForRoute } from "../registry.js";
import {
  applyProviderModelAliasToPayload,
  buildCodexResponsesImagesBody,
  buildFactory4xxDiagnostics,
  extractImagesFromCodexEventStream,
  extractImagesFromCodexResponse,
  joinUrl,
  responseLooksLikeEventStream,
  sleep,
  transientRetryDelayMs,
  recordAttempt,
  updateFailedAttemptDiagnostics,
  updateUsageCountsFromResponse,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type ProviderAvailabilitySummary,
  type ProviderRoutingExecutionResult,
  type ProviderStrategy,
  type StrategyRequestContext,
  type DirectExecutionProviderStrategy,
} from "../shared.js";
import { requestyModelProvider } from "../../model-family.js";
import { kernels, type ExecutorState } from "../../cljs-kernels.js";
import { buildRoutingCandidates } from "./candidate-builder.js";
import { emptyResult, type RoutingDeps } from "./types.js";

function shouldUseOpenAiCodexHeaderProfile(
  providerId: string,
  account: ProviderCredential,
  openaiProviderId: string,
): boolean {
  return providerId === openaiProviderId && account.authType === "oauth_bearer";
}

function transportErrorMessage(error: unknown): string {
  const base = toErrorMessage(error);
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return base;
  }

  const cause = (error as { readonly cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) {
    return base;
  }

  const causeRecord = cause as { readonly code?: unknown; readonly name?: unknown; readonly message?: unknown };
  const causeParts = [causeRecord.code, causeRecord.name, causeRecord.message]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return causeParts.length > 0 ? `${base} (${causeParts.join(": ")})` : base;
}

function candidateMatchesAffinity(
  candidate: { readonly providerId: string; readonly account: ProviderCredential },
  affinity: { readonly providerId: string; readonly accountId: string } | undefined,
): boolean {
  return affinity !== undefined
    && candidate.providerId === affinity.providerId
    && candidate.account.accountId === affinity.accountId;
}

type RoutingKeyPool = RoutingDeps["keyPool"];
type StepEvent = Record<string, unknown>;
type StepResult = ReturnType<typeof kernels.executorStep>;

/**
 * Executes the provider routing plan: iterates over routing candidates,
 * attempts each one, and handles success/failure/rate-limit outcomes.
 * Supports prompt-cache-key affinity for session stickiness and
 * hidden quota error detection (200 OK with error in stream body).
 *
 * The loop only sequences I/O. What each result costs the credential, whether to
 * retry, rotate or stop, and what to remember is decided by the pure state machine
 * `proxx.strategy.executor` (`kernels.executorStep`): the loop reports an event and
 * interprets the effects it returns, in order.
 */
export async function executeProviderRoutingPlan(
  strategy: ProviderStrategy,
  reply: FastifyReply,
  requestLogStore: RequestLogStore,
  promptAffinityStore: IPromptAffinityStore,
  providerRoutePheromoneStore: ProviderRoutePheromoneStore,
  keyPool: RoutingKeyPool,
  providerRoutes: readonly ProviderRoute[],
  context: StrategyRequestContext,
  payload: BuildPayloadResult,
  promptCacheKey?: string,
  refreshExpiredToken?: (credential: ProviderCredential) => Promise<ProviderCredential | null>,
  healthStore?: AccountHealthStore,
  eventStore?: EventStore,
  quotaMonitor?: QuotaMonitor,
  queueSignal?: AbortSignal,
): Promise<ProviderRoutingExecutionResult> {
  const manifestPath = context.config.cljsPolicyManifestPath;

  const deps: RoutingDeps = {
    strategy, reply, requestLogStore, promptAffinityStore, providerRoutePheromoneStore,
    keyPool, providerRoutes, context, payload, promptCacheKey, refreshExpiredToken,
    healthStore, eventStore, quotaMonitor,
  };

  const { candidates, preferredAffinity, provisionalAffinity } = await buildRoutingCandidates(deps);

  if (candidates.length === 0) {
    return emptyResult(0);
  }

  let exec: ExecutorState = kernels.createExecutorState({
    reassignmentAllowed: preferredAffinity === undefined || candidates.every(
      (candidate) => candidate.providerId !== preferredAffinity.providerId || candidate.account.accountId !== preferredAffinity.accountId,
    ),
    sticky: Boolean(promptCacheKey && (preferredAffinity || provisionalAffinity)),
  });
  const summary = (): ProviderRoutingExecutionResult["summary"] =>
    kernels.executorSummary(exec) as unknown as ProviderRoutingExecutionResult["summary"];
  const advance = (event: StepEvent): StepResult => {
    const result = kernels.executorStep(exec, event, manifestPath);
    exec = result.state;
    return result;
  };
  const handledResult = (): ProviderRoutingExecutionResult => ({ handled: true, candidateCount: candidates.length, summary: summary() });
  let abortRemainingCandidatesForStickyTransportFailure = false;

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (keyPool.isModelUnsupported?.(candidate.providerId, candidate.account.accountId, context.routedModel) === true) {
      advance({ type: "model-skipped" });
      continue;
    }

    const candidateStrategy = selectRemoteProviderStrategyForRoute(context, candidate.providerId);
    let candidatePayload = candidateStrategy === strategy
      ? payload
      : candidateStrategy.buildPayload(context);
    candidatePayload = applyProviderModelAliasToPayload(candidatePayload, context, candidate.providerId);

    // Requesty requires model names in "provider/model" format (e.g., "openai/gpt-5.4").
    if (candidate.providerId.trim().toLowerCase() === "requesty") {
      const model = typeof candidatePayload.upstreamPayload.model === "string"
        ? candidatePayload.upstreamPayload.model
        : "";
      const prefixedModel = kernels.requestyModel(model, requestyModelProvider(model));
      if (prefixedModel !== model) {
        const prefixed = { ...candidatePayload.upstreamPayload, model: prefixedModel };
        candidatePayload = { ...candidatePayload, upstreamPayload: prefixed, bodyText: JSON.stringify(prefixed) };
      }
    }

    const hasMoreCandidates = candidateIndex < candidates.length - 1;
    const releaseInFlight = keyPool.markInFlight(candidate.account);

    /** Facts about who is being tried, as the state machine reads them. */
    const ctxFor = (account: ProviderCredential): Record<string, unknown> => ({
      providerId: candidate.providerId,
      accountProviderId: account.providerId,
      authType: account.authType,
      hasRefreshToken: Boolean(account.refreshToken),
      keyCooldownMs: context.config.keyCooldownMs,
      promptCacheKey: Boolean(promptCacheKey),
      matchesPreferred: candidateMatchesAffinity({ providerId: candidate.providerId, account }, preferredAffinity),
      matchesProvisional: candidateMatchesAffinity({ providerId: candidate.providerId, account }, provisionalAffinity),
      preferredAffinity: preferredAffinity !== undefined,
      health: Boolean(healthStore),
      refreshAvailable: Boolean(refreshExpiredToken),
      ollamaCloud: account.providerId === "ollama-cloud" && Boolean(keyPool.clearAccountCooldown),
    });

    /** Interpret the state machine's effects against the stores and the key pool. */
    const runEffects = async (
      effects: StepResult["effects"],
      account: ProviderCredential,
      at: { readonly status?: number; readonly response?: Response; readonly logEntryId?: string; readonly emitResponse?: () => void; readonly retryIndex?: number },
    ): Promise<void> => {
      for (const effect of effects) {
        const [kind, a, b] = effect as [string, unknown, unknown];
        switch (kind) {
          case "mark-rate-limited":
            keyPool.markRateLimited(account, (a ?? undefined) as number | undefined);
            break;
          case "disable-account":
            keyPool.disableAccount?.(account.providerId, account.accountId);
            break;
          case "mark-model-unsupported":
            keyPool.markModelUnsupported?.(account, context.routedModel, a as number);
            break;
          case "clear-model-unsupported":
            keyPool.clearModelUnsupported?.(account.providerId, account.accountId, context.routedModel);
            break;
          case "clear-account-cooldown":
            keyPool.clearAccountCooldown?.(account.providerId, account.accountId);
            break;
          case "pheromone":
            if (a === "success") {
              await providerRoutePheromoneStore.noteSuccess(candidate.providerId, context.routedModel, b as number);
            } else {
              await providerRoutePheromoneStore.noteFailure(candidate.providerId, context.routedModel);
            }
            break;
          case "health":
            if (a === "success") {
              healthStore?.recordSuccess(account, at.status as number);
            } else if (typeof b === "string") {
              healthStore?.recordFailure(account, at.status as number, b);
            } else {
              healthStore?.recordFailure(account, at.status as number);
            }
            break;
          case "delete-affinity":
            await promptAffinityStore.delete(promptCacheKey as string);
            break;
          case "note-affinity-success":
            await promptAffinityStore.noteSuccess(promptCacheKey as string, candidate.providerId, account.accountId);
            break;
          case "log-upstream-error":
            requestLogStore.update(at.logEntryId as string, { upstreamErrorCode: a as string, upstreamErrorMessage: b as string });
            break;
          case "emit-response":
            at.emitResponse?.();
            break;
          case "summarize-error":
            await summarizeUpstreamError(at.response as Response);
            break;
          case "sleep":
            await sleep(transientRetryDelayMs(context, at.retryIndex ?? 0));
            break;
        }
      }
    };

    for (let retryIndex = 0; retryIndex <= context.config.upstreamTransientRetryCount; retryIndex += 1) {
      const baseProviderContext: Omit<ProviderAttemptContext, "attempt"> = {
        ...context,
        routeProviderId: candidate.providerId,
        providerId: candidate.providerId,
        // This may be overridden per-attempt when `OPENAI_IMAGES_UPSTREAM_MODE=platform|auto`.
        baseUrl: candidate.baseUrl,
        account: candidate.account,
        hasMoreCandidates,
        ...(candidate.paths ? { providerPaths: candidate.paths } : {}),
      };

      const primaryUpstreamPath = candidateStrategy.getUpstreamPath(baseProviderContext);
      const isOpenAiImages = candidate.providerId === context.config.openaiProviderId && candidateStrategy.mode === "images";
      const openAiPlatformImagesPath = context.config.imagesGenerationsPath;

      type UpstreamStepKind = "default" | "openai_platform" | "openai_chatgpt" | "openai_codex_responses_images";
      type UpstreamStep = {
        readonly baseUrl: string;
        readonly upstreamPath: string;
        readonly kind: UpstreamStepKind;
        /** HTTP statuses that should fall through to the *next base URL* step (used for platform → ChatGPT). */
        readonly tryNextBaseOnStatuses?: readonly number[];
      };

      const upstreamSteps: readonly UpstreamStep[] = (() => {
        if (!isOpenAiImages) {
          return [{ baseUrl: candidate.baseUrl, upstreamPath: primaryUpstreamPath, kind: "default" as const }];
        }
        const mode = context.config.openaiImagesUpstreamMode;

        // API keys should always use the Platform endpoint.
        if (candidate.account.authType === "api_key") {
          return [{ baseUrl: context.config.openaiApiBaseUrl, upstreamPath: openAiPlatformImagesPath, kind: "openai_platform" as const }];
        }

        // ChatGPT mode uses the Codex backend Responses stream + the built-in `image_generation`
        // tool, then translates the result back into an Images API-compatible response.
        if (mode === "chatgpt") {
          return [{
            baseUrl: context.config.openaiBaseUrl,
            upstreamPath: context.config.openaiResponsesPath,
            kind: "openai_codex_responses_images" as const,
          }];
        }

        if (mode === "platform") {
          return [{ baseUrl: context.config.openaiApiBaseUrl, upstreamPath: openAiPlatformImagesPath, kind: "openai_platform" as const }];
        }

        // auto: try Platform Images API first, then fall back to Codex Responses image generation
        // on auth/scope failures.
        return [
          {
            baseUrl: context.config.openaiApiBaseUrl,
            upstreamPath: openAiPlatformImagesPath,
            kind: "openai_platform" as const,
            tryNextBaseOnStatuses: [401, 403],
          },
          {
            baseUrl: context.config.openaiBaseUrl,
            upstreamPath: context.config.openaiResponsesPath,
            kind: "openai_codex_responses_images" as const,
          },
        ];
      })();

      const hasRetryRemaining = retryIndex < context.config.upstreamTransientRetryCount;
      let shouldContinueTransientRetry = false;

      for (const [stepIndex, step] of upstreamSteps.entries()) {
        const upstreamPath = step.upstreamPath;
        const attempt = advance({ type: "attempt-started" }).attempts;
        const providerContext: ProviderAttemptContext = {
          ...baseProviderContext,
          baseUrl: step.baseUrl,
          attempt,
        };

        const upstreamUrl = joinUrl(providerContext.baseUrl, upstreamPath);
        const upstreamHeaders = buildUpstreamHeadersForCredential(context.clientHeaders, candidate.account, {
          useOpenAiCodexHeaderProfile: shouldUseOpenAiCodexHeaderProfile(
            candidate.providerId,
            candidate.account,
            context.config.openaiProviderId,
          ),
        });
        candidateStrategy.applyRequestHeaders(upstreamHeaders, providerContext, candidatePayload.upstreamPayload);
        const attemptStartedAt = Date.now();

        const upstreamSpan = getTelemetry().startSpan("proxy.upstream_attempt", {
          "proxy.provider_id": candidate.providerId,
          "proxy.account_id": candidate.account.accountId,
          "proxy.auth_type": candidate.account.authType,
          "proxy.upstream_mode": candidateStrategy.mode,
          "proxy.upstream_path": upstreamPath,
          "proxy.model": context.routedModel,
          "proxy.requested_model": context.requestedModelInput,
          "proxy.base_url": providerContext.baseUrl,
          "proxy.routing_attempt": attempt,
        });
        upstreamSpan.setAttributes({
          "proxy.service_tier": candidatePayload.serviceTier,
          "proxy.service_tier_source": candidatePayload.serviceTierSource,
        });

        const isCodexResponsesImages = step.kind === "openai_codex_responses_images";
        const effectiveBody = isCodexResponsesImages
          ? buildCodexResponsesImagesBody(candidatePayload.upstreamPayload)
          : candidatePayload.bodyText;

        // Emit request event to the data lake before sending upstream.
        const attemptEntryId = `${candidate.providerId}:${candidate.account.accountId}:${Date.now()}`;
        if (eventStore) {
          eventStore.emitRequest(
            attemptEntryId,
            candidate.providerId,
            candidate.account.accountId,
            context.routedModel,
            candidatePayload.upstreamPayload,
            {
              upstreamMode: candidateStrategy.mode,
              upstreamPath,
              upstreamUrl,
              attempt,
              requestedModel: context.requestedModelInput,
              serviceTier: candidatePayload.serviceTier,
            },
          );
        }

        let upstreamResponse: Response;
        try {
          // Check if the strategy wants to handle execution directly (e.g., via SDK)
          const directExecution = candidateStrategy as Partial<DirectExecutionProviderStrategy>;
          if (directExecution.executeDirect) {
            const outcome = await directExecution.executeDirect(reply, providerContext, candidatePayload.upstreamPayload);
            const latencyMs = Date.now() - attemptStartedAt;
            upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);

            if (outcome.kind === "handled") {
              upstreamSpan.setStatus("ok");
              upstreamSpan.end();
              await runEffects(
                advance({ type: "handled", variant: "direct", ctx: ctxFor(candidate.account), latencyMs }).effects,
                candidate.account,
                {},
              );
              releaseInFlight();
              return handledResult();
            }

            // Track errors for continue outcomes
            advance({ type: "direct-declined", outcome });
            upstreamSpan.end();
            break;
          }

          upstreamResponse = await fetchWithResponseTimeout(upstreamUrl, {
            method: "POST",
            headers: upstreamHeaders,
            body: effectiveBody,
            signal: queueSignal,
          }, context.upstreamAttemptTimeoutMs);
        } catch (error) {
          const latencyMs = Date.now() - attemptStartedAt;
          upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);
          upstreamSpan.setAttribute("proxy.status", 0);
          upstreamSpan.recordError(error);
          upstreamSpan.end();
          const failed = advance({ type: "transport-error", ctx: ctxFor(candidate.account) });
          await runEffects(failed.effects, candidate.account, {});
          const logEntryId = recordAttempt(requestLogStore, providerContext, {
            providerId: candidate.providerId,
            accountId: candidate.account.accountId,
            authType: candidate.account.authType,
            upstreamPath,
            status: 0,
            latencyMs,
            serviceTier: candidatePayload.serviceTier,
            serviceTierSource: candidatePayload.serviceTierSource,
            factoryDiagnostics: buildFactory4xxDiagnostics(candidatePayload.upstreamPayload, promptCacheKey),
            error: transportErrorMessage(error)
          }, candidateStrategy.mode);

          if (eventStore) {
            eventStore.emitError(attemptEntryId, candidate.providerId, candidate.account.accountId, context.routedModel, 0, {
              error: transportErrorMessage(error),
              logEntryId,
            }, { latencyMs });
          }
          if (failed.abort) {
            abortRemainingCandidatesForStickyTransportFailure = true;
          }
          break;
        }

        const latencyMs = Date.now() - attemptStartedAt;
        upstreamSpan.setAttribute("proxy.status", upstreamResponse.status);
        upstreamSpan.setAttribute("proxy.latency_ms", latencyMs);

        const requestLogEntryId = recordAttempt(requestLogStore, providerContext, {
          providerId: candidate.providerId,
          accountId: candidate.account.accountId,
          authType: candidate.account.authType,
          upstreamPath,
          status: upstreamResponse.status,
          latencyMs,
          serviceTier: candidatePayload.serviceTier,
          serviceTierSource: candidatePayload.serviceTierSource,
          factoryDiagnostics: buildFactory4xxDiagnostics(candidatePayload.upstreamPayload, promptCacheKey),
          promptCacheKeyUsed: Boolean(promptCacheKey),
        }, candidateStrategy.mode);

        const diagnosticsPromise = updateFailedAttemptDiagnostics(
          requestLogStore,
          requestLogEntryId,
          upstreamResponse,
          candidate.providerId,
          candidatePayload.upstreamPayload,
          promptCacheKey,
        );

        // Emit error event for non-OK responses with the response body.
        if (eventStore && !upstreamResponse.ok) {
          try {
            const errorBody = await upstreamResponse.clone().json() as Record<string, unknown>;
            eventStore.emitError(
              attemptEntryId, candidate.providerId, candidate.account.accountId,
              context.routedModel, upstreamResponse.status, errorBody,
              { latencyMs, logEntryId: requestLogEntryId },
            );
          } catch {
            eventStore.emitError(
              attemptEntryId, candidate.providerId, candidate.account.accountId,
              context.routedModel, upstreamResponse.status,
              { status: upstreamResponse.status, statusText: upstreamResponse.statusText },
              { latencyMs, logEntryId: requestLogEntryId },
            );
          }
        }

        const usagePromise = updateUsageCountsFromResponse(
          requestLogStore,
          requestLogEntryId,
          upstreamResponse,
          candidateStrategy.mode,
          context.routedModel,
          candidate.providerId,
          context.config,
          attemptStartedAt,
        );
        if (responseLooksLikeEventStream(upstreamResponse, candidateStrategy.mode) && context.clientWantsStream) {
          void usagePromise;
        } else {
          await usagePromise;
        }
        await diagnosticsPromise;

        // OpenAI image generation can target either Platform Images API (`api.openai.com`) or the
        // ChatGPT Codex Responses backend (`chatgpt.com/backend-api/codex/responses`).
        // When `OPENAI_IMAGES_UPSTREAM_MODE=auto`, fall back from Platform → Codex Responses on
        // scope/auth failures.
        if (isOpenAiImages) {
          const nextStep = stepIndex < upstreamSteps.length - 1 ? upstreamSteps[stepIndex + 1] : undefined;
          const canTryNextBase = kernels.imagesNextBase({
            status: upstreamResponse.status,
            tryNextBaseOnStatuses: step.tryNextBaseOnStatuses,
            nextBaseDiffers: nextStep !== undefined && nextStep.baseUrl !== step.baseUrl,
          });

          if (canTryNextBase) {
            try {
              await upstreamResponse.arrayBuffer();
            } catch {
              // ignore
            }
            upstreamSpan.setStatus("error", "openai_images_try_next_base");
            upstreamSpan.end();
            continue;
          }

          // NOTE: We intentionally do not attempt alternate paths for Codex Responses image
          // generation. If the configured Codex Responses path is invalid, treat it as an upstream
          // rejection.
        }

        const ctx = ctxFor(candidate.account);

        if (isRateLimitResponse(upstreamResponse)) {
          advance({ type: "rate-limit-seen" });
          let ollamaMultiplier = 1;
          let ollamaLimitKind: ReturnType<typeof detectOllamaLimitKind> = "unknown";
          let responseBody: Record<string, unknown> | undefined;
          if (candidate.account.providerId === "ollama-cloud") {
            try {
              const cloned = upstreamResponse.clone();
              responseBody = await cloned.json() as Record<string, unknown>;
              ollamaLimitKind = detectOllamaLimitKind(responseBody);
              if (ollamaLimitKind === "weekly") {
                ollamaMultiplier = context.config.ollamaWeeklyCooldownMultiplier;
              }
            } catch {
              // If we can't parse the body, fall back to no multiplier.
            }
          }

          let cooldownMs: number | undefined;
          if (quotaMonitor?.tracksProvider(candidate.account.providerId)) {
            cooldownMs = quotaMonitor.getCooldownMs(candidate.account.accountId);
          }
          if (!cooldownMs) {
            cooldownMs = await extractRateLimitCooldownMs(upstreamResponse);
          }
          if (!cooldownMs && quotaMonitor?.tracksProvider(candidate.account.providerId)) {
            try {
              await quotaMonitor.refreshAccountQuota(candidate.account.accountId);
            } catch {
              // Ignore quota lookup failures and fall back to response-derived cooldowns.
            }
            // Use getCooldownMs (not getCooldownMsFromQuota) so we only derive
            // a long cooldown when the refreshed snapshot confirms exhaustion.
            // OpenAI quota windows always carry future reset timestamps even
            // when the account is healthy; getCooldownMsFromQuota would poison
            // the cooldown with a multi-day reset window on transient 429s.
            cooldownMs = quotaMonitor.getCooldownMs(candidate.account.accountId);
          }
          if (!cooldownMs) {
            cooldownMs = context.config.keyCooldownMs;
          }

          cooldownMs = Math.round(cooldownMs * ollamaMultiplier);

          // Parse the response body once for classification if not already done.
          if (!responseBody) {
            try {
              responseBody = await upstreamResponse.clone().json() as Record<string, unknown>;
            } catch {
              responseBody = undefined;
            }
          }

          const rateLimitKind = classifyRateLimitKind(
            responseBody,
            cooldownMs,
            context.config.concurrencyThrottleThresholdMs,
          );

          if (rateLimitKind === "concurrency_throttle") {
            // Concurrency throttle: wait for the indicated period, then retry
            // the same credential instead of falling over to a different provider.
            const maxRetries = context.config.concurrencyThrottleMaxRetries;
            const throttle = kernels.throttlePlan(cooldownMs, manifestPath);
            upstreamSpan.setAttribute("proxy.rate_limit_kind", "concurrency_throttle");
            upstreamSpan.setAttribute("proxy.concurrency_retry_wait_ms", throttle.waitMs);

            // Mark a short cooldown so the same account isn't selected by
            // another concurrent request while we're waiting.
            keyPool.markRateLimited(candidate.account, throttle.shortCooldownMs);

            for (let concurrencyRetry = 0; concurrencyRetry < maxRetries; concurrencyRetry += 1) {
              await sleep(throttle.waitMs);

              // Clear the short cooldown so we can re-use this account.
              if (keyPool.clearAccountCooldown) {
                keyPool.clearAccountCooldown(candidate.account.providerId, candidate.account.accountId);
              }

              const retryUrl = joinUrl(providerContext.baseUrl, primaryUpstreamPath);
              const retryHeaders = buildUpstreamHeadersForCredential(context.clientHeaders, candidate.account, {
                useOpenAiCodexHeaderProfile: shouldUseOpenAiCodexHeaderProfile(
                  candidate.providerId,
                  candidate.account,
                  context.config.openaiProviderId,
                ),
              });
              candidateStrategy.applyRequestHeaders(retryHeaders, providerContext, candidatePayload.upstreamPayload);

              let retryResponse: Response;
              try {
                retryResponse = await fetchWithResponseTimeout(retryUrl, {
                  method: "POST",
                  headers: retryHeaders,
                  body: effectiveBody,
                  signal: queueSignal,
                }, context.upstreamAttemptTimeoutMs);
              } catch {
                // Transport error on retry — fall through to normal routing.
                break;
              }

              if (!isRateLimitResponse(retryResponse)) {
                // No longer rate-limited: handle the response normally.
                const retryLatencyMs = Date.now() - attemptStartedAt;
                const retryLogId = recordAttempt(requestLogStore, providerContext, {
                  providerId: candidate.providerId,
                  accountId: candidate.account.accountId,
                  authType: candidate.account.authType,
                  upstreamPath,
                  status: retryResponse.status,
                  latencyMs: retryLatencyMs,
                  serviceTier: candidatePayload.serviceTier,
                  serviceTierSource: candidatePayload.serviceTierSource,
                  factoryDiagnostics: buildFactory4xxDiagnostics(candidatePayload.upstreamPayload, promptCacheKey),
                }, candidateStrategy.mode);

                const retryUsagePromise = updateUsageCountsFromResponse(
                  requestLogStore,
                  retryLogId,
                  retryResponse,
                  candidateStrategy.mode,
                  context.routedModel,
                  candidate.providerId,
                  context.config,
                  attemptStartedAt,
                );

                if (retryResponse.ok) {
                  await retryUsagePromise;
                  await runEffects(
                    advance({ type: "handled", variant: "throttle-retry", ctx, latencyMs: retryLatencyMs }).effects,
                    candidate.account,
                    { status: retryResponse.status },
                  );
                  upstreamSpan.setStatus("ok");
                  upstreamSpan.end();
                  releaseInFlight();
                  return handledResult();
                }

                // Non-429 error on retry — accumulate and break to routing loop.
                advance({ type: "throttle-error", status: retryResponse.status });
                try { await retryResponse.arrayBuffer(); } catch { /* ignore */ }
                break;
              }

              // Still 429 on retry — re-classify and either wait again or give up.
              let retryCooldownMs = await extractRateLimitCooldownMs(retryResponse);
              if (!retryCooldownMs) {
                retryCooldownMs = cooldownMs;
              }
              let retryBody: Record<string, unknown> | undefined;
              try {
                retryBody = await retryResponse.clone().json() as Record<string, unknown>;
              } catch {
                retryBody = undefined;
              }
              const retryKind = classifyRateLimitKind(retryBody, retryCooldownMs, context.config.concurrencyThrottleThresholdMs);
              try { await retryResponse.arrayBuffer(); } catch { /* ignore */ }

              if (kernels.throttleRetryVerdict({ rateLimited: true, ok: false, retryKind }) === "escalated") {
                // Escalated to quota exhaustion — stop retrying this credential.
                keyPool.markRateLimited(candidate.account, Math.round(retryCooldownMs * ollamaMultiplier));
                break;
              }

              // Still a concurrency throttle — mark short cooldown and loop again.
              keyPool.markRateLimited(candidate.account, kernels.throttlePlan(retryCooldownMs, manifestPath).shortCooldownMs);
            }

            // All concurrency retries exhausted — mark normal cooldown and fall over.
            keyPool.markRateLimited(candidate.account, cooldownMs);
          } else {
            // Quota exhaustion: mark rate-limited and fall over to next candidate.
            keyPool.markRateLimited(candidate.account, cooldownMs);
          }

          await runEffects(
            advance({ type: "rate-limited", ctx, limitKind: ollamaLimitKind }).effects,
            candidate.account,
            {},
          );
          upstreamSpan.setStatus("error", rateLimitKind === "concurrency_throttle" ? "concurrency_throttle" : "rate_limited");
          upstreamSpan.end();
          break;
        }

        if (await responseIndicatesQuotaError(upstreamResponse)) {
          const baseCooldownMs = kernels.quotaBaseCooldownMs({
            status: upstreamResponse.status,
            authType: candidate.account.authType,
            accountProviderId: candidate.account.providerId,
            keyCooldownMs: context.config.keyCooldownMs,
          }, manifestPath);
          let quotaCooldownMs: number | undefined;
          if (quotaMonitor?.tracksProvider(candidate.account.providerId)) {
            quotaCooldownMs = quotaMonitor.getCooldownMs(candidate.account.accountId);
            if (!quotaCooldownMs) {
              try {
                await quotaMonitor.refreshAccountQuota(candidate.account.accountId);
              } catch {
                // Ignore quota lookup failures and fall back to local cooldown heuristics.
              }
              quotaCooldownMs = quotaMonitor.getCooldownMs(candidate.account.accountId);
            }
          }
          if (!quotaCooldownMs) {
            quotaCooldownMs = await extractRateLimitCooldownMs(upstreamResponse);
          }
          if (!quotaCooldownMs) {
            quotaCooldownMs = healthStore
              ? healthStore.getGrowingCooldown(candidate.account.providerId, candidate.account.accountId, baseCooldownMs)
              : baseCooldownMs;
          }
          await runEffects(
            advance({ type: "quota-exhausted", ctx, cooldownMs: quotaCooldownMs }).effects,
            candidate.account,
            { status: upstreamResponse.status },
          );
          try {
            await upstreamResponse.arrayBuffer();
          } catch {
            // Ignore body read failures while failing over.
          }
          upstreamSpan.setStatus("error", "quota_exhausted");
          upstreamSpan.end();
          break;
        }

        // Factory intermittently returns 403 during auth token rotation, and gateways
        // return 5xx: retry on the same credential, or cool it down once retries are spent.
        const transient = kernels.transientStatus({
          status: upstreamResponse.status,
          providerId: candidate.providerId,
          hasRetryRemaining,
        }, manifestPath);
        if (transient === "transient-provider") {
          try { await upstreamResponse.arrayBuffer(); } catch { /* ignore */ }
          upstreamSpan.setStatus("error", "factory_transient_403");
          upstreamSpan.end();
          await runEffects(advance({ type: "transient-provider", ctx }).effects, candidate.account, { retryIndex });
          shouldContinueTransientRetry = true;
          break;
        }

        if (transient === "server-error-retry" || transient === "server-error") {
          const planned = advance({ type: "server-error", kind: transient, ctx });
          if (planned.next === "retry-credential") {
            try {
              await upstreamResponse.arrayBuffer();
            } catch {
              // Ignore body read failures while retrying.
            }
            upstreamSpan.setStatus("error", `upstream_server_error_${upstreamResponse.status}`);
            upstreamSpan.end();
            await runEffects(planned.effects, candidate.account, { retryIndex });
            shouldContinueTransientRetry = true;
            break;
          }
          await runEffects(planned.effects, candidate.account, { retryIndex });
          try {
            await upstreamResponse.arrayBuffer();
          } catch {
            // Ignore body read failures while failing over.
          }
          upstreamSpan.setStatus("error", `upstream_server_error_${upstreamResponse.status}`);
          upstreamSpan.end();
          break;
        }

        // Codex Responses API → Images API translation: read the streaming Responses output,
        // extract `image_generation_call` results, and synthesize an Images API JSON response.
        if (isCodexResponsesImages && upstreamResponse.ok) {
          const responseText = await upstreamResponse.text();
          const contentType = upstreamResponse.headers.get("content-type") ?? "";
          const looksLikeEventStream = kernels.isEventStreamOrUntyped(contentType);

          // Check for errors in the SSE stream.
          if (looksLikeEventStream) {
            const streamError = responsesEventStreamToErrorPayload(responseText);
            if (streamError) {
              upstreamSpan.setStatus("error", "codex_responses_stream_error");
              upstreamSpan.end();
              advance({ type: "codex-images-failed" });
              break;
            }
          }

          const imagesPayload = looksLikeEventStream
            ? extractImagesFromCodexEventStream(responseText)
            : extractImagesFromCodexResponse(responseText);

          if (imagesPayload) {
            reply.header("x-open-hax-upstream-provider", providerContext.providerId);
            reply.header("x-open-hax-upstream-mode", "codex_responses_images");
            reply.code(200);
            reply.header("content-type", "application/json");
            reply.send(imagesPayload);
            upstreamSpan.setStatus("ok");
            upstreamSpan.end();
            await runEffects(
              advance({ type: "handled", variant: "codex", ctx, latencyMs }).effects,
              candidate.account,
              { status: upstreamResponse.status },
            );
            releaseInFlight();
            return handledResult();
          }

          // Responses completed but contained no image_generation_call outputs.
          upstreamSpan.setStatus("error", "codex_responses_no_image_output");
          upstreamSpan.end();
          advance({ type: "codex-images-failed" });
          break;
        }

        reply.header("x-open-hax-upstream-mode", candidateStrategy.mode);
        const outcome = await candidateStrategy.handleProviderAttempt(reply, upstreamResponse, providerContext);
        if (outcome.kind === "handled") {
          upstreamSpan.setStatus("ok");
          upstreamSpan.end();
          await runEffects(
            advance({ type: "handled", variant: "strategy", ctx, ok: upstreamResponse.ok, latencyMs }).effects,
            candidate.account,
            {
              status: upstreamResponse.status,
              emitResponse: () => eventStore?.emitResponse(
                attemptEntryId, candidate.providerId, candidate.account.accountId,
                context.routedModel, upstreamResponse.status, null,
                { latencyMs: Date.now() - attemptStartedAt, logEntryId: requestLogEntryId },
              ),
            },
          );
          releaseInFlight();
          return handledResult();
        }

        // The strategy declined. Hidden upstream errors are 200s that carry a quota error
        // ("stream_quota_error") or an empty/invalid body ("stream_empty_or_invalid"): the
        // account cools down and the sticky affinity is dropped so the next candidate is tried.
        const declined = advance({ type: "declined", ctx, status: upstreamResponse.status, ok: upstreamResponse.ok, outcome });
        await runEffects(declined.effects, candidate.account, {
          status: upstreamResponse.status,
          response: upstreamResponse,
          logEntryId: requestLogEntryId,
        });

        if (declined.next === "refresh-token") {
          const refreshedCredential = await refreshExpiredToken!(candidate.account);
          if (refreshedCredential) {
            const refreshedCtx = ctxFor(refreshedCredential);
            const refreshedProviderContext: ProviderAttemptContext = { ...providerContext, account: refreshedCredential };
            const refreshedHeaders = buildUpstreamHeadersForCredential(context.clientHeaders, refreshedCredential, {
              useOpenAiCodexHeaderProfile: shouldUseOpenAiCodexHeaderProfile(
                candidate.providerId,
                refreshedCredential,
                context.config.openaiProviderId,
              ),
            });
            candidateStrategy.applyRequestHeaders(refreshedHeaders, refreshedProviderContext, candidatePayload.upstreamPayload);
            const refreshedRelease = keyPool.markInFlight(refreshedCredential);
            const refreshedAttemptStartedAt = Date.now();
            let refreshedResponse: Response;
            try {
              refreshedResponse = await fetchWithResponseTimeout(upstreamUrl, {
                method: "POST",
                headers: refreshedHeaders,
                body: effectiveBody,
                signal: queueSignal,
              }, context.upstreamAttemptTimeoutMs);
            } catch (error) {
              refreshedRelease();
              releaseInFlight();
              throw error;
            }

            try {
              const refreshedLatencyMs = Date.now() - refreshedAttemptStartedAt;
              const refreshedLogId = recordAttempt(requestLogStore, refreshedProviderContext, {
                providerId: candidate.providerId,
                accountId: refreshedCredential.accountId,
                authType: refreshedCredential.authType,
                upstreamPath,
                status: refreshedResponse.status,
                latencyMs: refreshedLatencyMs,
                serviceTier: candidatePayload.serviceTier,
                serviceTierSource: candidatePayload.serviceTierSource,
                factoryDiagnostics: buildFactory4xxDiagnostics(candidatePayload.upstreamPayload, promptCacheKey),
                promptCacheKeyUsed: Boolean(promptCacheKey),
              }, candidateStrategy.mode);
              const refreshedDiagnosticsPromise = updateFailedAttemptDiagnostics(
                requestLogStore,
                refreshedLogId,
                refreshedResponse,
                candidate.providerId,
                candidatePayload.upstreamPayload,
                promptCacheKey,
              );
              const refreshedUsagePromise = updateUsageCountsFromResponse(
                requestLogStore,
                refreshedLogId,
                refreshedResponse,
                candidateStrategy.mode,
                context.routedModel,
                candidate.providerId,
                context.config,
                refreshedAttemptStartedAt,
              );
              if (responseLooksLikeEventStream(refreshedResponse, candidateStrategy.mode) && context.clientWantsStream) {
                void refreshedUsagePromise;
              } else {
                await refreshedUsagePromise;
              }
              await refreshedDiagnosticsPromise;
              if (isRateLimitResponse(refreshedResponse)) {
                const refreshedCooldownMs = await extractRateLimitCooldownMs(refreshedResponse);
                await runEffects(
                  advance({ type: "refreshed-rate-limited", cooldownMs: refreshedCooldownMs }).effects,
                  refreshedCredential,
                  {},
                );
                try {
                  await refreshedResponse.arrayBuffer();
                } catch {
                  // Ignore body read failures while failing over after refresh.
                }
                break;
              }
              // Handle Codex Responses → Images translation for the refreshed response.
              if (isCodexResponsesImages && refreshedResponse.ok) {
                const refreshedText = await refreshedResponse.text();
                const refreshedContentType = refreshedResponse.headers.get("content-type") ?? "";
                const refreshedLooksLikeEventStream = kernels.isEventStreamOrUntyped(refreshedContentType);

                if (refreshedLooksLikeEventStream) {
                  const streamError = responsesEventStreamToErrorPayload(refreshedText);
                  if (streamError) {
                    upstreamSpan.setStatus("error", "codex_responses_stream_error");
                    upstreamSpan.end();
                    advance({ type: "codex-images-failed" });
                    break;
                  }
                }

                const refreshedImagesPayload = refreshedLooksLikeEventStream
                  ? extractImagesFromCodexEventStream(refreshedText)
                  : extractImagesFromCodexResponse(refreshedText);

                if (refreshedImagesPayload) {
                  reply.header("x-open-hax-upstream-provider", providerContext.providerId);
                  reply.header("x-open-hax-upstream-mode", "codex_responses_images");
                  reply.code(200);
                  reply.header("content-type", "application/json");
                  reply.send(refreshedImagesPayload);
                  upstreamSpan.setStatus("ok");
                  upstreamSpan.end();
                  await runEffects(
                    advance({ type: "handled", variant: "refreshed-codex", ctx: refreshedCtx, latencyMs: refreshedLatencyMs }).effects,
                    refreshedCredential,
                    { status: refreshedResponse.status },
                  );
                  releaseInFlight();
                  return handledResult();
                }
                upstreamSpan.setStatus("error", "codex_responses_no_image_output");
                upstreamSpan.end();
                advance({ type: "codex-images-failed" });
                break;
              }

              reply.header("x-open-hax-upstream-mode", candidateStrategy.mode);
              const refreshedOutcome = await candidateStrategy.handleProviderAttempt(reply, refreshedResponse, refreshedProviderContext);
              if (refreshedOutcome.kind === "handled") {
                upstreamSpan.setStatus("ok");
                upstreamSpan.end();
                await runEffects(
                  advance({ type: "handled", variant: "refreshed-strategy", ctx: refreshedCtx, ok: refreshedResponse.ok, latencyMs: refreshedLatencyMs }).effects,
                  refreshedCredential,
                  { status: refreshedResponse.status },
                );
                releaseInFlight();
                return handledResult();
              }
              await runEffects(
                advance({ type: "refreshed-declined", ctx: refreshedCtx, status: refreshedResponse.status, ok: refreshedResponse.ok, outcome: refreshedOutcome }).effects,
                refreshedCredential,
                { status: refreshedResponse.status },
              );
              break;
            } finally {
              refreshedRelease();
            }
          } else {
            const failedRefresh = advance({ type: "refresh-failed", ctx, ok: upstreamResponse.ok, outcome });
            await runEffects(failedRefresh.effects, candidate.account, {
              status: upstreamResponse.status,
              response: upstreamResponse,
              logEntryId: requestLogEntryId,
            });
          }
        }

        upstreamSpan.setStatus("error", `routing_continue_${upstreamResponse.status}`);
        upstreamSpan.end();
        break;
      }

      if (shouldContinueTransientRetry) {
        continue;
      }

      break;
    }

    releaseInFlight();

    if (abortRemainingCandidatesForStickyTransportFailure) {
      break;
    }
  }

  return {
    handled: false,
    candidateCount: candidates.length,
    summary: summary(),
  };
}


export async function inspectProviderAvailability(
  keyPool: {
    getStatus(providerId: string): Promise<{ readonly totalAccounts: number; readonly disabledAccounts?: number }>;
  },
  providerRoutes: readonly ProviderRoute[],
  promptCacheKey?: string,
): Promise<ProviderAvailabilitySummary> {
  let sawConfiguredProvider = false;
  let sawEnabledConfiguredProvider = false;

  for (const route of providerRoutes) {
    try {
      const status = await keyPool.getStatus(route.providerId);
      if (status.totalAccounts > 0) {
        sawConfiguredProvider = true;
        if (status.totalAccounts > (status.disabledAccounts ?? 0)) {
          sawEnabledConfiguredProvider = true;
        }
      }
    } catch {
      // Ignore status lookup errors and continue collecting provider info.
    }
  }

  return {
    sawConfiguredProvider,
    sawOnlyDisabledProviders: sawConfiguredProvider && !sawEnabledConfiguredProvider,
    prompt_cache_key: promptCacheKey,
  };
}
