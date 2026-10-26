/**
 * Request forwarding and rate-limit helpers. The decisions live in CLJS
 * (proxx.http.proxy); this module keeps the TypeScript signatures and the
 * Fastify reply plumbing.
 */
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyReply } from "fastify";

import { kernels } from "./cljs-kernels.js";
import type { ProviderCredential } from "./key-pool.js";

export function buildForwardHeaders(clientHeaders: IncomingHttpHeaders): Headers {
  return new Headers(kernels.buildForwardHeaders(clientHeaders));
}

export function buildUpstreamHeaders(clientHeaders: IncomingHttpHeaders, apiKey: string): Headers {
  return new Headers(kernels.buildUpstreamHeaders(clientHeaders, apiKey));
}

export function buildUpstreamHeadersForCredential(
  clientHeaders: IncomingHttpHeaders,
  credential: ProviderCredential,
  options?: { readonly useOpenAiCodexHeaderProfile?: boolean },
): Headers {
  return new Headers(kernels.buildUpstreamHeadersForCredential(clientHeaders, credential, options));
}

export function copyUpstreamHeaders(reply: FastifyReply, upstreamHeaders: Headers): void {
  for (const [name, value] of kernels.forwardableResponseHeaders([...upstreamHeaders.entries()])) {
    reply.header(name, value);
  }
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  return kernels.parseRetryAfterMs(value);
}

export function isRateLimitResponse(response: Response): boolean {
  return response.status === 429;
}

/**
 * - `quota_exhausted`: the account has consumed its allocation; fall over to
 *   another account.
 * - `concurrency_throttle`: too many requests in flight; wait for retry-after
 *   and retry the same credential.
 */
export type RateLimitKind = "quota_exhausted" | "concurrency_throttle";

export type OllamaLimitKind = "session" | "weekly" | "unknown";

export function detectOllamaLimitKind(errorBody: unknown): OllamaLimitKind {
  return kernels.detectOllamaLimitKind(errorBody);
}

export function classifyRateLimitKind(
  errorBody: unknown,
  retryAfterMs: number | undefined,
  concurrencyThresholdMs: number = 30_000,
): RateLimitKind {
  return kernels.classifyRateLimitKind(errorBody, retryAfterMs, concurrencyThresholdMs);
}

export function parseWaitTimeFromMessage(message: string): number | undefined {
  return kernels.parseWaitTimeFromMessage(message);
}

export async function extractRateLimitCooldownMs(response: Response): Promise<number | undefined> {
  return await kernels.extractRateLimitCooldownMs(response);
}

export function openAiError(
  message: string,
  type: string,
  code?: string
): { readonly error: { readonly message: string; readonly type: string; readonly code?: string; readonly param: null } } {
  return kernels.openAiError(message, type, code);
}
