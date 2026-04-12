/**
 * Error classification and detection utilities.
 */

import { isRecord, asString } from "../provider-utils.js";

/**
 * Convert an error to an error message string.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extract an error message from a payload object or string.
 */
export function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  const directMessage = asString(payload["message"]);
  if (directMessage) {
    return directMessage;
  }

  const errorValue = payload["error"];
  if (typeof errorValue === "string") {
    return errorValue;
  }

  if (!isRecord(errorValue)) {
    return undefined;
  }

  return asString(errorValue["message"])
    ?? asString(errorValue["error"])
    ?? asString(errorValue["code"]);
}

/**
 * Truncate a string for logging, with a maximum length.
 */
export function truncateForLog(value: string, maxLength = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

export const MODEL_NOT_SUPPORTED_WITH_CHATGPT_PATTERNS = [
  "model is not supported",
  "model is not available",
  "not supported when using codex",
  "not supported with a chatgpt account",
  "not supported with chatgpt account",
  "model_not_supported_for_account",
];

export const QUOTA_ERROR_PATTERNS = [
  "outstanding_balance",
  "outstanding-balance",
  "outstanding balance",
  "outstanding balence",
  "insufficient_balance",
  "insufficient-balance",
  "insufficient balance",
  "balance_exhausted",
  "balance-exhausted",
  "balance exhausted",
  "outstanding_quota",
  "outstanding-quota",
  "outstanding quota",
  "insufficient_quota",
  "insufficient-quota",
  "insufficient quota",
  "quota_exceeded",
  "quota-exceeded",
  "quota exceeded",
  "credits_exhausted",
  "credits-exhausted",
  "credits exhausted",
  "credit_exhausted",
  "credit-exhausted",
  "credit exhausted",
  "insufficient_credits",
  "insufficient-credits",
  "insufficient credits",
  "payment_required",
  "payment-required",
  "payment required",
  "monthly limit",
];

/**
 * Check if a message indicates a quota error.
 */
export function messageIndicatesQuotaError(message: string): boolean {
  const lowered = message.toLowerCase();
  const normalized = lowered.replace(/[\s_-]+/g, " ");

  return QUOTA_ERROR_PATTERNS.some((pattern) => {
    const normalizedPattern = pattern.replace(/[\s_-]+/g, " ");
    return lowered.includes(pattern) || normalized.includes(normalizedPattern);
  });
}

/**
 * Check if a payload looks like an error object.
 */
export function payloadLooksLikeError(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  if (payload.error !== undefined) {
    return true;
  }

  const type = asString(payload.type);
  if (type && type.toLowerCase().includes("error")) {
    return true;
  }

  const event = asString(payload.event);
  if (event && event.toLowerCase().includes("error")) {
    return true;
  }

  const object = asString(payload.object);
  if (object && object.toLowerCase().includes("error")) {
    return true;
  }

  return false;
}

/**
 * Check if a response is an event stream.
 */
export function responseIsEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Extract SSE data lines from a payload.
 */
function extractSseDataLines(payload: string): string[] {
  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
}

/**
 * Check if an SSE stream payload indicates a quota error.
 */
export function streamPayloadIndicatesQuotaError(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(data);
      if (!payloadLooksLikeError(parsed)) {
        continue;
      }

      const message = extractErrorMessage(parsed);
      if (message && messageIndicatesQuotaError(message)) {
        return true;
      }

      if (messageIndicatesQuotaError(data)) {
        return true;
      }
    } catch {
      if (messageIndicatesQuotaError(data)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a response indicates a quota error.
 */
export async function responseIndicatesQuotaError(response: Response): Promise<boolean> {
  if (response.status === 402) {
    return true;
  }

  if (response.status === 429 || response.status === 403 || response.status === 503) {
    return false;
  }

  if (responseIsEventStream(response)) {
    return false;
  }

  // Skip body inspection for responses with no content-type (likely SSE from Codex backends).
  // Cloning such responses creates unnecessary tee chains that can interfere with downstream readers.
  if ((response.headers.get("content-type") ?? "").length === 0) {
    return false;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    try {
      payload = await response.clone().text();
    } catch {
      return false;
    }
  }

  const payloadIsErrorLike = payloadLooksLikeError(payload);
  if (response.status >= 200 && response.status < 300 && !payloadIsErrorLike) {
    return false;
  }

  const message = extractErrorMessage(payload);
  if (message) {
    return messageIndicatesQuotaError(message);
  }

  if (!payloadIsErrorLike) {
    return false;
  }

  try {
    return messageIndicatesQuotaError(JSON.stringify(payload));
  } catch {
    return false;
  }
}

/**
 * Check if a response indicates that the requested model is missing.
 */
export async function responseIndicatesMissingModel(response: Response, requestedModel: string): Promise<boolean> {
  if (![400, 404, 422].includes(response.status)) {
    return false;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    try {
      payload = await response.clone().text();
    } catch {
      return false;
    }
  }

  const message = extractErrorMessage(payload);
  if (!message) {
    return false;
  }

  const lowered = message.toLowerCase();
  if (!lowered.includes("model") || !lowered.includes("not found")) {
    return false;
  }

  const normalizedRequestedModel = requestedModel.trim().toLowerCase();
  return normalizedRequestedModel.length === 0
    || lowered.includes(normalizedRequestedModel)
    || lowered.includes("model_not_found");
}

/**
 * Check if a response indicates that the model is not supported for the account.
 */
export async function responseIndicatesModelNotSupportedForAccount(response: Response, requestedModel: string): Promise<boolean> {
  if (response.status !== 400 && response.status !== 422) {
    return false;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    try {
      payload = await response.clone().text();
    } catch {
      return false;
    }
  }

  const message = extractErrorMessage(payload);
  if (!message) {
    return false;
  }

  const lowered = message.toLowerCase();

  if (!MODEL_NOT_SUPPORTED_WITH_CHATGPT_PATTERNS.some(pattern => lowered.includes(pattern))) {
    return false;
  }

  const normalizedRequestedModel = requestedModel.trim().toLowerCase();
  if (normalizedRequestedModel.length === 0) {
    return true;
  }

  const modelInMessage = lowered.includes(normalizedRequestedModel);
  const accountMentioned = lowered.includes("chatgpt") || lowered.includes("account");

  return modelInMessage || accountMentioned;
}

export interface UpstreamErrorSummary {
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
}

/**
 * Summarize an upstream error from a response.
 */
export async function summarizeUpstreamError(response: Response): Promise<UpstreamErrorSummary> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      return text.length > 0 ? { upstreamErrorMessage: truncateForLog(text) } : {};
    } catch {
      return {};
    }
  }

  if (!isRecord(payload)) {
    return {};
  }

  const errorValue = isRecord(payload.error) ? payload.error : null;
  const code = asString(errorValue?.code) ?? asString(payload.code);
  const type = asString(errorValue?.type) ?? asString(payload.type);
  const message = extractErrorMessage(payload);

  return {
    upstreamErrorCode: code ? truncateForLog(code, 80) : undefined,
    upstreamErrorType: type ? truncateForLog(type, 80) : undefined,
    upstreamErrorMessage: message ? truncateForLog(message) : undefined,
  };
}
