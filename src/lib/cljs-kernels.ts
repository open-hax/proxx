/**
 * Typed handle to the CLJS runtime's pure kernels.
 *
 * The runtime is loaded with a top-level await, so any module that imports
 * this one can call the kernels synchronously. The compiled artifact is
 * required: these functions are the implementation, not an optimization.
 */
import { loadCljsRuntime } from "./cljs-runtime.js";

type JsRecord = Record<string, unknown>;

export interface CljsKernels {
  // errors/classification
  readonly extractErrorMessage: (payload: unknown) => string | null;
  readonly truncateForLog: (value: string, maxLength?: number) => string;
  readonly messageIndicatesQuotaError: (message: string) => boolean;
  readonly payloadLooksLikeError: (payload: unknown) => boolean;
  readonly streamPayloadIndicatesQuotaError: (payload: string) => boolean;
  readonly responseIndicatesQuotaError: (response: Response) => Promise<boolean>;
  readonly responseIndicatesMissingModel: (response: Response, requestedModel: string) => Promise<boolean>;
  readonly responseIndicatesModelNotSupportedForAccount: (response: Response, requestedModel: string) => Promise<boolean>;
  readonly summarizeUpstreamError: (response: Response) => Promise<{
    readonly upstreamErrorCode?: string;
    readonly upstreamErrorType?: string;
    readonly upstreamErrorMessage?: string;
  }>;
  // sse
  readonly extractSseDataLines: (payload: string) => string[];
  readonly stripSseCommentLines: (payload: string) => string;
  readonly chatCompletionHasReasoningContent: (completion: JsRecord) => boolean;
  readonly streamPayloadHasReasoningTrace: (payload: string) => boolean;
  readonly streamPayloadHasSubstantiveChunks: (payload: string) => boolean;
  // messages compat
  readonly shouldUseMessagesUpstream: (model: unknown, prefixes: readonly string[]) => boolean;
  readonly normalizeMessagesThinkingBudget: (payload: JsRecord) => JsRecord;
  readonly chatRequestToMessagesRequest: (body: JsRecord) => JsRecord;
  readonly messagesToChatCompletion: (body: unknown, fallbackModel: string) => JsRecord;
  // responses compat
  readonly shouldUseResponsesUpstream: (model: unknown, prefixes: readonly string[]) => boolean;
  readonly chatRequestToResponsesRequest: (body: JsRecord) => JsRecord;
  readonly responsesRequestToChatRequest: (body: JsRecord) => JsRecord;
  readonly chatCompletionToResponsesResponse: (completion: unknown) => JsRecord;
  readonly responsesToChatCompletion: (response: unknown, fallbackModel: string) => JsRecord;
  readonly responsesOutputHasReasoning: (response: unknown) => boolean;
  readonly responsesEventStreamToErrorPayload: (streamText: string) => JsRecord | undefined;
  readonly extractTerminalResponseFromEventStream: (streamText: string) => JsRecord | undefined;
  readonly responsesEventStreamToChatCompletion: (streamText: string, fallbackModel: string) => JsRecord;
  readonly chatCompletionEventStreamToResponsesEventStream: (streamText: string, fallbackModel: string) => string;
  readonly chatCompletionEventStreamToResponsesResponse: (streamText: string, fallbackModel: string) => JsRecord;
  readonly chatCompletionToSse: (completion: JsRecord) => string;
  readonly writeInterleavedResponsesSse: (
    responseBody: JsRecord,
    fallbackModel: string,
    writeFn: (data: string) => void,
  ) => Promise<void>;
  readonly streamResponsesSseToChatCompletionChunks: (
    body: ReadableStream<Uint8Array>,
    options: { readonly fallbackModel: string; readonly writeFn: (data: string) => void },
  ) => Promise<{ terminalResponse: JsRecord | null; sawError: JsRecord | null }>;
  // key pool
  readonly loadProviderSeedSpecs: (manifestPath: string) => readonly {
    readonly providerIdEnvNames: readonly string[];
    readonly providerIdFallback: string;
    readonly keyEnvNames: readonly string[];
  }[];
  readonly createKeyPool: (config: unknown, deps: unknown) => unknown;
}

const loaded = await loadCljsRuntime({ required: true });
if (!loaded.loaded) {
  throw new Error(`CLJS runtime is required: ${loaded.reason}`);
}

export const kernels = loaded.runtime as unknown as CljsKernels;
