import type { IncomingHttpHeaders } from "node:http";
import type { FastifyReply } from "fastify";

import type { ProviderCredential } from "./key-pool.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const OPENAI_BROWSER_FINGERPRINT_HEADERS = new Set([
  "accept-language",
  "cookie",
  "dnt",
  "origin",
  "priority",
  "referer",
  "upgrade-insecure-requests",
  "user-agent",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cdn-loop",
]);

function isOpenAiBrowserFingerprintHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return OPENAI_BROWSER_FINGERPRINT_HEADERS.has(normalized)
    || normalized.startsWith("sec-")
    || normalized.startsWith("x-forwarded-");
}

function applyOpenAiCodexHeaderProfile(headers: Headers): Headers {
  const headerNames = [...headers.keys()];
  for (const name of headerNames) {
    if (isOpenAiBrowserFingerprintHeader(name)) {
      headers.delete(name);
    }
  }

  headers.set("originator", "codex_cli_rs");
  return headers;
}

function asHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value;
}

export function buildForwardHeaders(clientHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  for (const [rawName, rawValue] of Object.entries(clientHeaders)) {
    if (BLOCKED_REQUEST_HEADERS.has(rawName.toLowerCase())) {
      continue;
    }

    const value = asHeaderValue(rawValue);
    if (typeof value === "string" && value.length > 0) {
      headers.set(rawName, value);
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

export function buildUpstreamHeaders(clientHeaders: IncomingHttpHeaders, apiKey: string): Headers {
  const headers = buildForwardHeaders(clientHeaders);
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export function buildUpstreamHeadersForCredential(
  clientHeaders: IncomingHttpHeaders,
  credential: ProviderCredential,
  options?: { readonly useOpenAiCodexHeaderProfile?: boolean },
): Headers {
  const headers = buildUpstreamHeaders(clientHeaders, credential.token);
  if (credential.chatgptAccountId) {
    headers.set("chatgpt-account-id", credential.chatgptAccountId);
  }
  if (options?.useOpenAiCodexHeaderProfile) {
    applyOpenAiCodexHeaderProfile(headers);
  }
  return headers;
}

export function copyUpstreamHeaders(reply: FastifyReply, upstreamHeaders: Headers): void {
  for (const [name, value] of upstreamHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    reply.header(name, value);
  }
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

export function isRateLimitResponse(response: Response): boolean {
  return response.status === 429;
}

/**
 * Parse wait time from rate limit error messages.
 * Handles OpenAI-style messages like:
 * - "Please wait 23.5 seconds before making another request."
 * - "Please try again in 2m30s."
 * - "Rate limit reached. Please wait 1.37s."
 * - "Please try again in 1 hour 30 minutes."
 * - "Rate limit reached. Please try again in 5d 12h."
 */
export function parseWaitTimeFromMessage(message: string): number | undefined {
  if (typeof message !== "string") {
    return undefined;
  }

  const lower = message.toLowerCase();

  // Pattern: days hours minutes seconds (e.g., "5d 12h", "1 hour 30 minutes", "2 days 3 hours 45 minutes")
  // Extract all duration components and sum them - check for full format first
  const fullMatch = lower.match(/(\d+(?:\.\d+)?)\s*(d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\b/gi);
  if (fullMatch) {
    let totalMs = 0;
    for (const match of fullMatch) {
      const durationMatch = match.match(/(\d+(?:\.\d+)?)\s*(d|days?|h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)/i);
      if (durationMatch) {
        const value = parseFloat(durationMatch[1]!);
        const unit = durationMatch[2]!.toLowerCase();
        if (unit.startsWith('d')) {
          totalMs += Math.ceil(value * 24 * 60 * 60 * 1000);
        } else if (unit.startsWith('h')) {
          totalMs += Math.ceil(value * 60 * 60 * 1000);
        } else if (unit.startsWith('m')) {
          totalMs += Math.ceil(value * 60 * 1000);
        } else if (unit.startsWith('s')) {
          totalMs += Math.ceil(value * 1000);
        }
      }
    }
    if (totalMs > 0) {
      return totalMs;
    }
  }

  // Pattern: XmYs or Xm Ys (e.g., "2m30s", "2m 30s", "try again in 5m 0s")
  const combinedMatch = lower.match(/(\d+)\s*m\s*(\d+)\s*s/i);
  if (combinedMatch) {
    const minutes = parseInt(combinedMatch[1]!, 10);
    const seconds = parseInt(combinedMatch[2]!, 10);
    if (minutes > 0 || seconds > 0) {
      return (minutes * 60 + seconds) * 1000;
    }
  }

  // Pattern: X.XX seconds or X.XXs (e.g., "23.5 seconds", "1.37s", "30s", "11.054s")
  const secondsMatch = lower.match(/(\d+(?:\.\d+)?)\s*(s(?:econds?)?|seconds?|secs?)\b/i);
  if (secondsMatch) {
    const seconds = parseFloat(secondsMatch[1]!);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Pattern: X minute(s) or X min
  const minutesMatch = lower.match(/(\d+)\s*(?:minutes?|mins?)\b/i);
  if (minutesMatch) {
    const minutes = parseInt(minutesMatch[1]!, 10);
    if (minutes > 0) {
      return minutes * 60 * 1000;
    }
  }

  // Pattern: X hour(s)
  const hoursMatch = lower.match(/(\d+)\s*(?:hours?|hrs?)\b/i);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]!, 10);
    if (hours > 0) {
      return hours * 60 * 60 * 1000;
    }
  }

  return undefined;
}

/**
 * Extract cooldown duration from a 429 response.
 * First checks the retry-after header, then parses the response body for wait times.
 */
export async function extractRateLimitCooldownMs(response: Response): Promise<number | undefined> {
  // First, try the retry-after header (standard HTTP mechanism)
  const headerRetryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
  if (headerRetryAfter !== undefined && headerRetryAfter > 0) {
    return headerRetryAfter;
  }

  // Then, try to extract wait time from the response body
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/")) {
    return undefined;
  }

  try {
    const cloned = response.clone();
    const body: unknown = await cloned.json();

    // OpenAI-style error: { error: { message: "..." } }
    if (typeof body === "object" && body !== null) {
      const error = (body as Record<string, unknown>)["error"];
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>)["message"];
        if (typeof message === "string") {
          return parseWaitTimeFromMessage(message);
        }
      }
    }
  } catch {
    // Ignore JSON parse errors
  }

  return undefined;
}

export function openAiError(
  message: string,
  type: string,
  code?: string
): { readonly error: { readonly message: string; readonly type: string; readonly code?: string; readonly param: null } } {
  return {
    error: {
      message,
      type,
      code,
      param: null
    }
  };
}
