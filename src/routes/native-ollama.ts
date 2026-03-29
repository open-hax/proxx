import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import {
  nativeChatToOpenAiRequest,
  nativeGenerateToChatRequest,
  nativeEmbedToOpenAiRequest,
  chatCompletionToNativeChat,
  chatCompletionToNativeGenerate,
  openAiEmbeddingsToNativeEmbed,
  openAiEmbeddingsToNativeEmbeddings,
} from "../lib/ollama-native.js";
import { copyInjectedResponseHeaders } from "../lib/request-utils.js";
import { parseJsonIfPossible } from "../lib/request-utils.js";
import { isRecord } from "../lib/provider-utils.js";

export function registerNativeOllamaRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.post<{ Body: Record<string, unknown> }>("/api/chat", async (request, reply) => {
    const bridgeResponse = await deps.injectNativeBridge(
      "/v1/chat/completions",
      nativeChatToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body ?? "null");
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["choices"])) {
      reply.send(chatCompletionToNativeChat(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/generate", async (request, reply) => {
    const bridgeResponse = await deps.injectNativeBridge(
      "/v1/chat/completions",
      nativeGenerateToChatRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body ?? "null");
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["choices"])) {
      reply.send(chatCompletionToNativeGenerate(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embed", async (request, reply) => {
    const bridgeResponse = await deps.injectNativeBridge(
      "/v1/embeddings",
      nativeEmbedToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body ?? "null");
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["data"])) {
      reply.send(openAiEmbeddingsToNativeEmbed(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/embeddings", async (request, reply) => {
    const bridgeResponse = await deps.injectNativeBridge(
      "/v1/embeddings",
      nativeEmbedToOpenAiRequest(isRecord(request.body) ? request.body : {}),
      request.headers,
    );

    copyInjectedResponseHeaders(reply, bridgeResponse.headers as Record<string, string | string[] | undefined>);
    reply.code(bridgeResponse.statusCode);

    const contentType = String(bridgeResponse.headers["content-type"] ?? "application/json");
    const parsed = parseJsonIfPossible(bridgeResponse.body ?? "null");
    if (contentType.toLowerCase().includes("application/json") && isRecord(parsed) && Array.isArray(parsed["data"])) {
      reply.send(openAiEmbeddingsToNativeEmbeddings(parsed));
      return;
    }

    reply.send(bridgeResponse.body);
  });
}
