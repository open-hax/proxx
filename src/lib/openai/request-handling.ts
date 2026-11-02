/**
 * OpenAI-specific request and response handling utilities. The facts read off a
 * request (prompt cache key, interleaved thinking, the Responses summary for
 * the logs, CSV header merging) are pure CLJS (proxx.http.request-facts).
 */

import { kernels } from "../cljs-kernels.js";
import { sendOpenAiError } from "../provider-utils.js";

/** The one OpenAI-shaped error sender (provider-utils). */
export { sendOpenAiError };

/** The trimmed, non-empty prompt cache key of a request body. */
export const extractPromptCacheKey = (body: Record<string, unknown>): string | undefined =>
  kernels.extractPromptCacheKey(body);

/** A prompt cache key safe for logging (`sha256:<12 hex>`). */
export const hashPromptCacheKey = (promptCacheKey: string): string =>
  kernels.hashPromptCacheKey(promptCacheKey);

/** Add a value to a CSV-style header unless it is already listed. */
export const appendCsvHeaderValue = (headers: Headers, name: string, value: string): void =>
  kernels.appendCsvHeaderValue(headers, name, value);

/** Does the upstream payload ask for extended thinking? */
export const shouldEnableInterleavedThinkingHeader = (upstreamPayload: Record<string, unknown>): boolean =>
  kernels.shouldEnableInterleavedThinkingHeader(upstreamPayload);

/** Does the request want the reasoning trace in the response? */
export const requestWantsReasoningTrace = (body: Record<string, unknown>): boolean =>
  kernels.requestWantsReasoningTrace(body);

/** A log-safe summary of a Responses API request body. */
export const summarizeResponsesRequestBody = (body: Record<string, unknown>): Record<string, unknown> =>
  kernels.summarizeResponsesRequestBody(body);
