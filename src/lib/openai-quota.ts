import type { CredentialAccountView, CredentialStoreLike } from "./credential-store.js";
import {
  chatRequestToResponsesRequest,
  extractTerminalResponseFromEventStream,
  responsesEventStreamToErrorPayload,
  responsesToChatCompletion,
} from "./responses-compat.js";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_REFRESH_BUFFER_MS = 60 * 1000;
const OPENAI_USAGE_TIMEOUT_MS = 15_000;
const OPENAI_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_PROBE_MODEL = "gpt-5.2";
const DEFAULT_OPENAI_PROBE_EXPECTED_TEXT = "hello";

export interface OpenAiQuotaWindow {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly resetAfterSeconds: number | null;
  readonly limitWindowSeconds: number | null;
}

export interface OpenAiQuotaRateLimit {
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  readonly primaryWindow: OpenAiQuotaWindow | null;
  readonly secondaryWindow: OpenAiQuotaWindow | null;
}

export interface OpenAiQuotaAccountSnapshot {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly status: "ok" | "error";
  readonly fetchedAt: string;
  readonly fiveHour: OpenAiQuotaWindow | null;
  readonly weekly: OpenAiQuotaWindow | null;
  readonly rateLimit: OpenAiQuotaRateLimit | null;
  readonly codeReviewRateLimit: OpenAiQuotaRateLimit | null;
  readonly error?: string;
}

export interface OpenAiQuotaSnapshotResponse {
  readonly generatedAt: string;
  readonly accounts: readonly OpenAiQuotaAccountSnapshot[];
}

export interface OpenAiAccountProbeResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly testedAt: string;
  readonly model: string;
  readonly expectedText: string;
  readonly status: "ok" | "error";
  readonly ok: boolean;
  readonly matchesExpectedOutput: boolean;
  readonly outputText?: string;
  readonly upstreamStatus?: number;
  readonly errorCode?: string;
  readonly message: string;
}

interface LoggerLike {
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
}

interface JwtClaims {
  readonly sub?: string;
  readonly email?: string;
  readonly chatgpt_account_id?: string;
  readonly "https://api.openai.com/profile"?: {
    readonly email?: string;
  };
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_plan_type?: string;
  };
}

interface RefreshedOpenAiTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? (parsed as JwtClaims) : undefined;
  } catch {
    return undefined;
  }
}

function deriveOAuthMetadataFromToken(token: string): {
  readonly email?: string;
  readonly subject?: string;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
} {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return {};
  }

  const profile = isRecord(claims["https://api.openai.com/profile"])
    ? claims["https://api.openai.com/profile"]
    : undefined;
  const auth = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : undefined;

  const email = (asString(claims.email) ?? asString(profile?.email))?.trim().toLowerCase();
  const subject = asString(claims.sub)?.trim();
  const chatgptAccountId = (asString(claims.chatgpt_account_id)
    ?? asString(auth?.chatgpt_account_id))?.trim();
  const planType = asString(auth?.chatgpt_plan_type)?.trim().toLowerCase();

  return {
    email: email && email.length > 0 ? email : undefined,
    subject: subject && subject.length > 0 ? subject : undefined,
    chatgptAccountId: chatgptAccountId && chatgptAccountId.length > 0 ? chatgptAccountId : undefined,
    planType: planType && planType.length > 0 ? planType : undefined,
  };
}

function normalizePercent(value: number): number {
  const normalized = value > 0 && value < 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, normalized));
}

function parseResetTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsedNumber = Number(trimmed);
  if (Number.isFinite(parsedNumber)) {
    return parsedNumber > 1e12 ? Math.round(parsedNumber) : Math.round(parsedNumber * 1000);
  }

  const parsedDate = new Date(trimmed).getTime();
  return Number.isNaN(parsedDate) ? undefined : parsedDate;
}

function normalizeResetsAt(resetsAt: unknown, resetAfterSeconds: number | undefined): string | null {
  const resetTimestampMs = parseResetTimestampMs(resetsAt);
  if (typeof resetTimestampMs === "number") {
    return new Date(resetTimestampMs).toISOString();
  }

  if (typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds)) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }

  return null;
}

function normalizeResetAfterSeconds(resetsAt: unknown, resetAfterSeconds: number | undefined): number | null {
  if (typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds)) {
    return Math.max(0, Math.round(resetAfterSeconds));
  }

  const resetTimestampMs = parseResetTimestampMs(resetsAt);
  if (typeof resetTimestampMs === "number") {
    return Math.max(0, Math.round((resetTimestampMs - Date.now()) / 1000));
  }

  return null;
}

function parseQuotaWindow(value: unknown): OpenAiQuotaWindow | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawUsedPercent = asNumber(value.used_percent)
    ?? asNumber(value.usedPercent)
    ?? asNumber(value.percent_used)
    ?? asNumber(value.percentUsed);
  const rawRemainingPercent = asNumber(value.remaining_percent)
    ?? asNumber(value.remainingPercent)
    ?? asNumber(value.percent_remaining)
    ?? asNumber(value.percentRemaining);
  const usedUnits = asNumber(value.used)
    ?? asNumber(value.used_units)
    ?? asNumber(value.usedUnits)
    ?? asNumber(value.used_tokens)
    ?? asNumber(value.usedTokens);
  const remainingUnits = asNumber(value.remaining)
    ?? asNumber(value.remaining_units)
    ?? asNumber(value.remainingUnits)
    ?? asNumber(value.remaining_tokens)
    ?? asNumber(value.remainingTokens);
  const limitUnits = asNumber(value.limit)
    ?? asNumber(value.quota)
    ?? asNumber(value.total)
    ?? asNumber(value.max)
    ?? asNumber(value.maximum);
  const rawResetsAt = value.resets_at
    ?? value.resetsAt
    ?? value.reset_at
    ?? value.resetAt
    ?? value.reset;
  const rawResetAfterSeconds = asNumber(value.reset_after_seconds) ?? asNumber(value.resetAfterSeconds);
  const rawLimitWindowSeconds = asNumber(value.limit_window_seconds) ?? asNumber(value.limitWindowSeconds);

  let usedPercent = typeof rawUsedPercent === "number" ? normalizePercent(rawUsedPercent) : null;
  let remainingPercent = typeof rawRemainingPercent === "number" ? normalizePercent(rawRemainingPercent) : null;

  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = Math.max(0, 100 - usedPercent);
  }

  if (usedPercent === null && remainingPercent !== null) {
    usedPercent = Math.max(0, 100 - remainingPercent);
  }

  if ((usedPercent === null || remainingPercent === null) && typeof limitUnits === "number" && limitUnits > 0) {
    if (usedPercent === null && typeof usedUnits === "number") {
      usedPercent = normalizePercent((usedUnits / limitUnits) * 100);
    }
    if (remainingPercent === null && typeof remainingUnits === "number") {
      remainingPercent = normalizePercent((remainingUnits / limitUnits) * 100);
    }
  }

  const resetsAt = normalizeResetsAt(rawResetsAt, rawResetAfterSeconds);
  const resetAfterSeconds = normalizeResetAfterSeconds(rawResetsAt, rawResetAfterSeconds);

  if (usedPercent === null && remainingPercent === null && !resetsAt && resetAfterSeconds === null && rawLimitWindowSeconds === undefined) {
    return null;
  }

  return {
    usedPercent,
    remainingPercent,
    resetsAt,
    resetAfterSeconds,
    limitWindowSeconds: rawLimitWindowSeconds ?? null,
  };
}

function parseQuotaRateLimit(value: unknown): OpenAiQuotaRateLimit | null {
  if (!isRecord(value)) {
    return null;
  }

  const primaryWindow = parseQuotaWindow(value.primary_window ?? value.primaryWindow ?? value.primary);
  const secondaryWindow = parseQuotaWindow(value.secondary_window ?? value.secondaryWindow ?? value.secondary);
  const allowed = asBoolean(value.allowed) ?? null;
  const limitReached = asBoolean(value.limit_reached) ?? asBoolean(value.limitReached) ?? null;

  if (allowed === null && limitReached === null && primaryWindow === null && secondaryWindow === null) {
    return null;
  }

  return {
    allowed,
    limitReached,
    primaryWindow,
    secondaryWindow,
  };
}

function quotaErrorMessage(responseStatus: number, responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return `HTTP ${responseStatus}`;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
      const detailCode = asString(detail?.code)?.trim();
      const detailMessage = asString(detail?.message)?.trim();

      if (detailCode && detailCode.length > 0) {
        return detailMessage && detailMessage.length > 0
          ? `${detailCode}: ${detailMessage}`
          : detailCode;
      }

      const message = asString(parsed.message)
        ?? (isRecord(parsed.error) ? asString(parsed.error.message) ?? asString(parsed.error) : undefined)
        ?? asString(parsed.detail);
      if (message && message.trim().length > 0) {
        return message.trim();
      }
    }
  } catch {
    // Fall through to plain text.
  }

  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function quotaErrorCode(responseText: string): string | undefined {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
    const detailCode = asString(detail?.code)?.trim()?.toLowerCase();
    if (detailCode && detailCode.length > 0) {
      return detailCode;
    }

    const error = isRecord(parsed.error) ? parsed.error : undefined;
    const errorCode = (asString(error?.code) ?? asString(parsed.code))?.trim()?.toLowerCase();
    return errorCode && errorCode.length > 0 ? errorCode : undefined;
  } catch {
    return undefined;
  }
}

async function refreshOpenAiToken(refreshToken: string, fetchFn: typeof fetch): Promise<RefreshedOpenAiTokens | null> {
  const response = await fetchFn(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  if (!isRecord(payload)) {
    return null;
  }

  const accessToken = asString(payload.access_token)?.trim();
  const nextRefreshToken = asString(payload.refresh_token)?.trim();
  const expiresIn = asNumber(payload.expires_in);

  if (!accessToken || !nextRefreshToken) {
    return null;
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined,
  };
}

async function refreshAccountTokens(
  providerId: string,
  account: CredentialAccountView,
  credentialStore: CredentialStoreLike,
  fetchFn: typeof fetch,
  logger?: LoggerLike,
): Promise<CredentialAccountView | null> {
  const refreshToken = account.refreshToken?.trim();
  if (!refreshToken) {
    return null;
  }

  const refreshed = await refreshOpenAiToken(refreshToken, fetchFn);
  if (!refreshed) {
    logger?.warn?.({ providerId, accountId: account.id }, "failed to refresh OpenAI account token");
    return null;
  }

  const derived = deriveOAuthMetadataFromToken(refreshed.accessToken);
  const nextAccount: CredentialAccountView = {
    ...account,
    secret: refreshed.accessToken,
    secretPreview: account.secretPreview,
    refreshToken: refreshed.refreshToken,
    refreshTokenPreview: account.refreshTokenPreview,
    expiresAt: refreshed.expiresAt,
    chatgptAccountId: derived.chatgptAccountId ?? account.chatgptAccountId,
    email: derived.email ?? account.email,
    subject: derived.subject ?? account.subject,
    planType: derived.planType ?? account.planType,
  };

  await credentialStore.upsertOAuthAccount(
    providerId,
    nextAccount.id,
    refreshed.accessToken,
    refreshed.refreshToken,
    refreshed.expiresAt,
    nextAccount.chatgptAccountId,
    nextAccount.email,
    nextAccount.subject,
    nextAccount.planType,
  );

  await credentialStore.flush?.();

  logger?.info?.({ providerId, accountId: account.id }, "refreshed OpenAI account token");
  return nextAccount;
}

function accountNeedsRefresh(account: CredentialAccountView): boolean {
  if (account.authType !== "oauth_bearer") {
    return false;
  }

  if (typeof account.expiresAt !== "number") {
    return false;
  }

  return account.expiresAt <= Date.now() + OPENAI_REFRESH_BUFFER_MS;
}

async function ensureFreshAccount(
  providerId: string,
  account: CredentialAccountView,
  credentialStore: CredentialStoreLike,
  fetchFn: typeof fetch,
  logger?: LoggerLike,
): Promise<CredentialAccountView> {
  if (!accountNeedsRefresh(account)) {
    return account;
  }

  const refreshedAccount = await refreshAccountTokens(providerId, account, credentialStore, fetchFn, logger);
  return refreshedAccount ?? account;
}

async function fetchUsagePayload(
  accessToken: string,
  chatgptAccountId: string | undefined,
  fetchFn: typeof fetch,
): Promise<{ readonly payload: unknown; readonly resolvedChatgptAccountId?: string }> {
  const attempt = async (workspaceId: string | undefined): Promise<{ readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly status: number; readonly text: string }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, OPENAI_USAGE_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        originator: "codex_cli_rs",
      };
      if (workspaceId && workspaceId.trim().length > 0) {
        headers["chatgpt-account-id"] = workspaceId.trim();
      }

      const response = await fetchFn(OPENAI_USAGE_URL, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, status: response.status, text };
      }

      const payload = await response.json();
      return { ok: true, payload };
    } finally {
      clearTimeout(timeout);
    }
  };

  const primary = await attempt(chatgptAccountId);
  if (primary.ok) {
    return { payload: primary.payload, resolvedChatgptAccountId: chatgptAccountId };
  }

  const code = quotaErrorCode(primary.text);
  const shouldRetryWithoutWorkspace = (code === "deactivated_workspace" || code === "invalid_workspace")
    && typeof chatgptAccountId === "string"
    && chatgptAccountId.trim().length > 0;

  if (shouldRetryWithoutWorkspace) {
    const fallback = await attempt(undefined);
    if (fallback.ok) {
      return { payload: fallback.payload, resolvedChatgptAccountId: undefined };
    }
    throw new Error(quotaErrorMessage(fallback.status, fallback.text));
  }

  throw new Error(quotaErrorMessage(primary.status, primary.text));
}

function normalizePlanType(payload: unknown, fallback?: string): string | undefined {
  if (!isRecord(payload)) {
    return fallback;
  }

  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const planType = asString(usage.plan_type)?.trim().toLowerCase();
  return planType && planType.length > 0 ? planType : fallback;
}

function extractQuotaDetails(payload: unknown): {
  readonly fiveHour: OpenAiQuotaWindow | null;
  readonly weekly: OpenAiQuotaWindow | null;
  readonly rateLimit: OpenAiQuotaRateLimit | null;
  readonly codeReviewRateLimit: OpenAiQuotaRateLimit | null;
} {
  if (!isRecord(payload)) {
    return { fiveHour: null, weekly: null, rateLimit: null, codeReviewRateLimit: null };
  }

  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const rateLimit = parseQuotaRateLimit(usage.rate_limit ?? usage.rateLimit);
  const codeReviewRateLimit = parseQuotaRateLimit(usage.code_review_rate_limit ?? usage.codeReviewRateLimit);
  const primaryWindow = rateLimit?.primaryWindow ?? parseQuotaWindow(usage.primary ?? usage.session ?? usage.fiveHour ?? usage.five_hour);
  const secondaryWindow = rateLimit?.secondaryWindow ?? parseQuotaWindow(usage.secondary ?? usage.weekly ?? usage.week);

  return {
    fiveHour: primaryWindow,
    weekly: secondaryWindow,
    rateLimit,
    codeReviewRateLimit,
  };
}

async function listOpenAiOAuthAccounts(
  credentialStore: CredentialStoreLike,
  providerId: string,
  accountId?: string,
): Promise<CredentialAccountView[]> {
  const providers = await credentialStore.listProviders(true);
  const provider = providers.find((entry) => entry.id === providerId);
  return (provider?.accounts ?? [])
    .filter((account) => account.authType === "oauth_bearer")
    .filter((account) => !accountId || account.id === accountId)
    .sort((left, right) => {
      const leftLabel = (left.email ?? left.displayName ?? left.id).toLowerCase();
      const rightLabel = (right.email ?? right.displayName ?? right.id).toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
}

async function fetchQuotaForAccount(
  providerId: string,
  account: CredentialAccountView,
  credentialStore: CredentialStoreLike,
  fetchFn: typeof fetch,
  logger?: LoggerLike,
): Promise<OpenAiQuotaAccountSnapshot> {
  const fetchedAt = new Date().toISOString();

  try {
    const freshAccount = await ensureFreshAccount(providerId, account, credentialStore, fetchFn, logger);
    const accessToken = freshAccount.secret?.trim();
    if (!accessToken) {
      return {
        providerId,
        accountId: freshAccount.id,
        displayName: freshAccount.displayName,
        email: freshAccount.email,
        planType: freshAccount.planType,
        chatgptAccountId: freshAccount.chatgptAccountId,
        status: "error",
        fetchedAt,
        fiveHour: null,
        weekly: null,
        rateLimit: null,
        codeReviewRateLimit: null,
        error: "Missing access token",
      };
    }

    const rawChatgptAccountId = freshAccount.chatgptAccountId?.trim();
    const chatgptAccountId = rawChatgptAccountId && rawChatgptAccountId.length > 0 ? rawChatgptAccountId : undefined;

    const usageResult = await fetchUsagePayload(accessToken, chatgptAccountId, fetchFn);
    const payload = usageResult.payload;
    const resolvedChatgptAccountId = usageResult.resolvedChatgptAccountId;

    const { fiveHour, weekly, rateLimit, codeReviewRateLimit } = extractQuotaDetails(payload);
    const planType = normalizePlanType(payload, freshAccount.planType);

    const shouldPersistPlanType = Boolean(planType && planType !== freshAccount.planType);
    const shouldPersistWorkspace = resolvedChatgptAccountId !== chatgptAccountId;

    if (shouldPersistPlanType || shouldPersistWorkspace) {
      await credentialStore.upsertOAuthAccount(
        providerId,
        freshAccount.id,
        accessToken,
        freshAccount.refreshToken,
        freshAccount.expiresAt,
        resolvedChatgptAccountId,
        freshAccount.email,
        freshAccount.subject,
        planType,
      );

      await credentialStore.flush?.();
    }

    return {
      providerId,
      accountId: freshAccount.id,
      displayName: freshAccount.displayName,
      email: freshAccount.email,
      planType,
      chatgptAccountId: resolvedChatgptAccountId,
      status: "ok",
      fetchedAt,
      fiveHour,
      weekly,
      rateLimit,
      codeReviewRateLimit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.({ providerId, accountId: account.id, error: message }, "failed to fetch OpenAI quota usage");
    return {
      providerId,
      accountId: account.id,
      displayName: account.displayName,
      email: account.email,
      planType: account.planType,
      chatgptAccountId: account.chatgptAccountId,
      status: "error",
      fetchedAt,
      fiveHour: null,
      weekly: null,
      rateLimit: null,
      codeReviewRateLimit: null,
      error: message,
    };
  }
}

function buildProbePayload(model: string): Record<string, unknown> {
  const payload = chatRequestToResponsesRequest({
    model,
    messages: [{ role: "user", content: "Reply with exactly hello." }],
    reasoning_effort: "none",
  });

  payload.instructions = "";
  payload.store = false;
  payload.stream = true;
  return payload;
}

function extractCompletionText(completion: Record<string, unknown>): string {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return "";
  }

  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  const content = asString(message?.content)?.trim();
  return content ?? "";
}

async function fetchProbeResponsePayload(
  accessToken: string,
  chatgptAccountId: string | undefined,
  baseUrl: string,
  path: string,
  model: string,
  fetchFn: typeof fetch,
): Promise<
  | {
    readonly ok: true;
    readonly payload: unknown;
    readonly resolvedChatgptAccountId?: string;
    readonly upstreamStatus: number;
  }
  | {
    readonly ok: false;
    readonly status: number;
    readonly text: string;
    readonly errorCode?: string;
    readonly resolvedChatgptAccountId?: string;
  }
> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const attempt = async (workspaceId: string | undefined) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, OPENAI_PROBE_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
        originator: "codex_cli_rs",
      };
      if (workspaceId && workspaceId.trim().length > 0) {
        headers["chatgpt-account-id"] = workspaceId.trim();
      }

      const response = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(buildProbePayload(model)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          ok: false as const,
          status: response.status,
          text,
          errorCode: quotaErrorCode(text),
          resolvedChatgptAccountId: workspaceId,
        };
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream") || contentType.length === 0) {
        const streamText = await response.text();
        const upstreamError = responsesEventStreamToErrorPayload(streamText);
        if (upstreamError) {
          const text = JSON.stringify({ error: upstreamError });
          return {
            ok: false as const,
            status: 400,
            text,
            errorCode: quotaErrorCode(text),
            resolvedChatgptAccountId: workspaceId,
          };
        }

        const terminalResponse = extractTerminalResponseFromEventStream(streamText);
        if (!terminalResponse) {
          return {
            ok: false as const,
            status: 502,
            text: "OpenAI Codex probe stream completed without a terminal response.",
            resolvedChatgptAccountId: workspaceId,
          };
        }

        return {
          ok: true as const,
          payload: terminalResponse,
          resolvedChatgptAccountId: workspaceId,
          upstreamStatus: response.status,
        };
      }

      return {
        ok: true as const,
        payload: await response.json(),
        resolvedChatgptAccountId: workspaceId,
        upstreamStatus: response.status,
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const primary = await attempt(chatgptAccountId);
  if (primary.ok) {
    return primary;
  }

  const shouldRetryWithoutWorkspace = (primary.errorCode === "deactivated_workspace" || primary.errorCode === "invalid_workspace")
    && typeof chatgptAccountId === "string"
    && chatgptAccountId.trim().length > 0;

  if (shouldRetryWithoutWorkspace) {
    return attempt(undefined);
  }

  return primary;
}

export async function fetchOpenAiQuotaSnapshots(
  credentialStore: CredentialStoreLike,
  options: {
    readonly providerId: string;
    readonly accountId?: string;
    readonly fetchFn?: typeof fetch;
    readonly logger?: LoggerLike;
  },
): Promise<OpenAiQuotaSnapshotResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const accounts = await listOpenAiOAuthAccounts(credentialStore, options.providerId, options.accountId);

  const snapshots = await Promise.all(
    accounts.map((account) => fetchQuotaForAccount(options.providerId, account, credentialStore, fetchFn, options.logger)),
  );

  return {
    generatedAt: new Date().toISOString(),
    accounts: snapshots,
  };
}

export async function probeOpenAiAccount(
  credentialStore: CredentialStoreLike,
  options: {
    readonly providerId: string;
    readonly accountId: string;
    readonly openAiBaseUrl: string;
    readonly openAiResponsesPath: string;
    readonly model?: string;
    readonly fetchFn?: typeof fetch;
    readonly logger?: LoggerLike;
  },
): Promise<OpenAiAccountProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const testedAt = new Date().toISOString();
  const model = options.model?.trim() || DEFAULT_OPENAI_PROBE_MODEL;
  const expectedText = DEFAULT_OPENAI_PROBE_EXPECTED_TEXT;
  const [account] = await listOpenAiOAuthAccounts(credentialStore, options.providerId, options.accountId);

  if (!account) {
    throw new Error(`OpenAI account not found: ${options.accountId}`);
  }

  let freshAccount = await ensureFreshAccount(options.providerId, account, credentialStore, fetchFn, options.logger);

  const runProbe = async (currentAccount: CredentialAccountView) => {
    const accessToken = currentAccount.secret?.trim();
    if (!accessToken) {
      return {
        ok: false as const,
        status: 401,
        text: "Missing access token.",
        resolvedChatgptAccountId: currentAccount.chatgptAccountId,
      };
    }

    return fetchProbeResponsePayload(
      accessToken,
      currentAccount.chatgptAccountId?.trim() || undefined,
      options.openAiBaseUrl,
      options.openAiResponsesPath,
      model,
      fetchFn,
    );
  };

  let probeResponse = await runProbe(freshAccount);

  if (!probeResponse.ok && probeResponse.errorCode === "token_expired") {
    const refreshedAccount = await refreshAccountTokens(options.providerId, freshAccount, credentialStore, fetchFn, options.logger);
    if (refreshedAccount) {
      freshAccount = refreshedAccount;
      probeResponse = await runProbe(freshAccount);
    }
  }

  if (!probeResponse.ok) {
    return {
      providerId: options.providerId,
      accountId: freshAccount.id,
      displayName: freshAccount.displayName,
      email: freshAccount.email,
      planType: freshAccount.planType,
      chatgptAccountId: probeResponse.resolvedChatgptAccountId ?? freshAccount.chatgptAccountId,
      testedAt,
      model,
      expectedText,
      status: "error",
      ok: false,
      matchesExpectedOutput: false,
      upstreamStatus: probeResponse.status,
      errorCode: probeResponse.errorCode,
      message: quotaErrorMessage(probeResponse.status, probeResponse.text),
    };
  }

  try {
    const completion = responsesToChatCompletion(probeResponse.payload, model);
    const outputText = extractCompletionText(completion);
    const trimmedOutput = outputText.trim();
    const matchesExpectedOutput = trimmedOutput.toLowerCase() === expectedText;
    const message = matchesExpectedOutput
      ? `Live — replied with ${JSON.stringify(trimmedOutput || expectedText)}.`
      : trimmedOutput.length > 0
        ? `Live — replied with ${JSON.stringify(trimmedOutput)}.`
        : "Live — request completed without assistant text.";

    return {
      providerId: options.providerId,
      accountId: freshAccount.id,
      displayName: freshAccount.displayName,
      email: freshAccount.email,
      planType: freshAccount.planType,
      chatgptAccountId: probeResponse.resolvedChatgptAccountId ?? freshAccount.chatgptAccountId,
      testedAt,
      model,
      expectedText,
      status: "ok",
      ok: true,
      matchesExpectedOutput,
      outputText: trimmedOutput || undefined,
      upstreamStatus: probeResponse.upstreamStatus,
      message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      providerId: options.providerId,
      accountId: freshAccount.id,
      displayName: freshAccount.displayName,
      email: freshAccount.email,
      planType: freshAccount.planType,
      chatgptAccountId: probeResponse.resolvedChatgptAccountId ?? freshAccount.chatgptAccountId,
      testedAt,
      model,
      expectedText,
      status: "error",
      ok: false,
      matchesExpectedOutput: false,
      upstreamStatus: probeResponse.upstreamStatus,
      message,
    };
  }
}
