/**
 * Ollama native API <-> OpenAI wire translation. The translation lives in CLJS
 * (proxx.compat.ollama-native); this module keeps the TypeScript signatures.
 */
import { randomUUID } from "node:crypto";

import { kernels } from "./cljs-kernels.js";

type JsRecord = Record<string, unknown>;

export function nativeChatToOpenAiRequest(body: JsRecord): JsRecord {
  return kernels.nativeChatToOpenAiRequest(body);
}

export function nativeGenerateToChatRequest(body: JsRecord): JsRecord {
  return kernels.nativeGenerateToChatRequest(body);
}

export function chatCompletionToNativeChat(response: JsRecord): JsRecord {
  return kernels.chatCompletionToNativeChat(response);
}

export function chatCompletionToNativeGenerate(response: JsRecord): JsRecord {
  return kernels.chatCompletionToNativeGenerate(response);
}

export function nativeEmbedToOpenAiRequest(body: JsRecord): {
  readonly model: string;
  readonly input: string | readonly string[];
  readonly num_ctx?: number;
  readonly ollama_num_ctx?: number;
} {
  return kernels.nativeEmbedToOpenAiRequest(body);
}

export function nativeEmbedToOllamaRequest(body: JsRecord, defaultNumCtx?: number): JsRecord {
  return kernels.nativeEmbedToOllamaRequest(body, defaultNumCtx);
}

export function openAiEmbeddingsToNativeEmbed(response: JsRecord): JsRecord {
  return kernels.openAiEmbeddingsToNativeEmbed(response);
}

export function openAiEmbeddingsToNativeEmbeddings(response: JsRecord): JsRecord {
  return kernels.openAiEmbeddingsToNativeEmbeddings(response);
}

export function nativeEmbedResponseToOpenAiEmbeddings(response: JsRecord, model: string): JsRecord {
  return kernels.nativeEmbedResponseToOpenAiEmbeddings(response, model);
}

export function modelIdsToNativeTags(modelIds: readonly string[]): JsRecord {
  return kernels.modelIdsToNativeTags(modelIds, () => randomUUID().replace(/-/g, ""));
}
