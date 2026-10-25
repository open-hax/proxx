/**
 * SSE (Server-Sent Events) parsing utilities.
 *
 * The implementation is the pure CLJS event model (`proxx.sse`); these are the
 * stable TypeScript entry points.
 */

import { kernels } from "../cljs-kernels.js";

/** Non-empty `data:` payloads of an SSE body, in order. */
export const extractSseDataLines = (payload: string): string[] => kernels.extractSseDataLines(payload);

/** Remove comment lines (starting with ":") from an SSE payload. */
export const stripSseCommentLines = (payload: string): string => kernels.stripSseCommentLines(payload);

/** Does a chat completion (or chunk) carry reasoning text? */
export const chatCompletionHasReasoningContent = (completion: Record<string, unknown>): boolean =>
  kernels.chatCompletionHasReasoningContent(completion);

/** Does any well-formed event in an SSE stream carry reasoning? */
export const streamPayloadHasReasoningTrace = (payload: string): boolean =>
  kernels.streamPayloadHasReasoningTrace(payload);

/** Does an SSE stream hold anything beyond empty reasoning deltas? */
export const streamPayloadHasSubstantiveChunks = (payload: string): boolean =>
  kernels.streamPayloadHasSubstantiveChunks(payload);
