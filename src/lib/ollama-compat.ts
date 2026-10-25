/**
 * OpenAI chat-completions <-> Ollama translation. Pure CLJS
 * (`proxx.compat.ollama`); the NDJSON byte reader lives in the runtime edge.
 */
import { kernels } from "./cljs-kernels.js";

export const requestHasExplicitNumCtx = (requestBody: Record<string, unknown>): boolean =>
  kernels.requestHasExplicitNumCtx(requestBody);

export const shouldUseOllamaUpstream = (model: unknown, prefixes: readonly string[]): boolean =>
  kernels.shouldUseOllamaUpstream(model, prefixes);

export const chatRequestToOllamaRequest = (
  requestBody: Record<string, unknown>,
  modelPrefixes: readonly string[],
): Record<string, unknown> => kernels.chatRequestToOllamaRequest(requestBody, modelPrefixes);

export const ollamaToChatCompletion = (responseBody: unknown, fallbackModel: string): Record<string, unknown> =>
  kernels.ollamaToChatCompletion(responseBody, fallbackModel);

export const streamOllamaNdjsonToChatCompletionSse = (
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  writeFn: (data: string) => void,
): Promise<void> => kernels.streamOllamaNdjsonToChatCompletionSse(body, fallbackModel, writeFn);
