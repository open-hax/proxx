/**
 * Error classification and detection utilities.
 *
 * Every decision is made by the pure CLJS verdicts (`proxx.errors.classification`);
 * these are the stable TypeScript entry points.
 */

import { kernels } from "../cljs-kernels.js";

/**
 * Convert an error to an error message string.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extract an error message from a payload object or string. */
export const extractErrorMessage = (payload: unknown): string | undefined =>
  kernels.extractErrorMessage(payload) ?? undefined;

/** Truncate a string for logging, with a maximum length. */
export const truncateForLog = (value: string, maxLength = 240): string => kernels.truncateForLog(value, maxLength);

/** Check if a message indicates a quota error. */
export const messageIndicatesQuotaError = (message: string): boolean => kernels.messageIndicatesQuotaError(message);

/** Check if a payload looks like an error object. */
export const payloadLooksLikeError = (payload: unknown): boolean => kernels.payloadLooksLikeError(payload);

/** Check if a response is an event stream. */
export function responseIsEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/** Check if an SSE stream payload indicates a quota error. */
export const streamPayloadIndicatesQuotaError = (payload: string): boolean =>
  kernels.streamPayloadIndicatesQuotaError(payload);

/** Check if a response indicates a quota error. */
export const responseIndicatesQuotaError = (response: Response): Promise<boolean> =>
  kernels.responseIndicatesQuotaError(response);

/** Check if a response indicates that the requested model is missing. */
export const responseIndicatesMissingModel = (response: Response, requestedModel: string): Promise<boolean> =>
  kernels.responseIndicatesMissingModel(response, requestedModel);

/** Check if a response indicates that the model is not supported for the account. */
export const responseIndicatesModelNotSupportedForAccount = (
  response: Response,
  requestedModel: string,
): Promise<boolean> => kernels.responseIndicatesModelNotSupportedForAccount(response, requestedModel);

export interface UpstreamErrorSummary {
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
}

/** Summarize an upstream error from a response. */
export const summarizeUpstreamError = (response: Response): Promise<UpstreamErrorSummary> =>
  kernels.summarizeUpstreamError(response);
