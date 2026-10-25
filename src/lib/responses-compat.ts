/**
 * OpenAI chat-completions <-> Responses API translation.
 *
 * Translation and stream reduction are pure CLJS (`proxx.compat.responses*`);
 * these are the stable TypeScript entry points.
 */

import { kernels } from "./cljs-kernels.js";

type JsRecord = Record<string, unknown>;

export const shouldUseResponsesUpstream = (model: unknown, prefixes: readonly string[]): boolean =>
  kernels.shouldUseResponsesUpstream(model, prefixes);

export const chatRequestToResponsesRequest = (requestBody: JsRecord): JsRecord =>
  kernels.chatRequestToResponsesRequest(requestBody);

export const responsesRequestToChatRequest = (requestBody: JsRecord): JsRecord =>
  kernels.responsesRequestToChatRequest(requestBody);

export const chatCompletionToResponsesResponse = (completionBody: unknown): JsRecord =>
  kernels.chatCompletionToResponsesResponse(completionBody);

export const responsesToChatCompletion = (responseBody: unknown, fallbackModel: string): JsRecord =>
  kernels.responsesToChatCompletion(responseBody, fallbackModel);

export const responsesEventStreamToErrorPayload = (streamText: string): JsRecord | undefined =>
  kernels.responsesEventStreamToErrorPayload(streamText);

export const responsesEventStreamToChatCompletion = (streamText: string, fallbackModel: string): JsRecord =>
  kernels.responsesEventStreamToChatCompletion(streamText, fallbackModel);

export const chatCompletionEventStreamToResponsesEventStream = (streamText: string, fallbackModel: string): string =>
  kernels.chatCompletionEventStreamToResponsesEventStream(streamText, fallbackModel);

export const chatCompletionEventStreamToResponsesResponse = (streamText: string, fallbackModel: string): JsRecord =>
  kernels.chatCompletionEventStreamToResponsesResponse(streamText, fallbackModel);

export const chatCompletionToSse = (completion: JsRecord): string => kernels.chatCompletionToSse(completion);

export const responsesOutputHasReasoning = (responseBody: unknown): boolean =>
  kernels.responsesOutputHasReasoning(responseBody);

export const extractTerminalResponseFromEventStream = (streamText: string): JsRecord | undefined =>
  kernels.extractTerminalResponseFromEventStream(streamText);

export const writeInterleavedResponsesSse = (
  responseBody: JsRecord,
  fallbackModel: string,
  writeFn: (data: string) => void,
): Promise<void> => kernels.writeInterleavedResponsesSse(responseBody, fallbackModel, writeFn);

export interface ResponsesStreamTranslatorOptions {
  readonly fallbackModel: string;
  readonly writeFn: (data: string) => void;
}

/**
 * Incrementally translate a Responses API SSE stream into chat completion chunks.
 * Returns the terminal response (for usage extraction) and any error event seen.
 */
export const streamResponsesSseToChatCompletionChunks = (
  body: ReadableStream<Uint8Array>,
  options: ResponsesStreamTranslatorOptions,
): Promise<{ terminalResponse: JsRecord | null; sawError: JsRecord | null }> =>
  kernels.streamResponsesSseToChatCompletionChunks(body, options);
