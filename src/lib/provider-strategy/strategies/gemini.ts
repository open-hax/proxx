import { GoogleGenAI } from "@google/genai";
import type { FastifyReply } from "fastify";

import { resolveModelAliasWithCljs } from "../../cljs-runtime.js";
import { kernels } from "../../cljs-kernels.js";
import { BaseProviderStrategy } from "../base.js";
import {
  buildPayloadResult,
  buildRequestBodyForUpstream,
  type BuildPayloadResult,
  type DirectExecutionProviderStrategy,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
} from "../shared.js";
import { chatCompletionToSse } from "../../responses-compat.js";
import { chatCompletionHasReasoningContent } from "../../sse/index.js";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

type GeminiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/*
 * Request/response translation is pure data transformation in CLJS
 * (`proxx.strategy.gemini`); only the SDK/HTTP effects remain here.
 */
export function normalizeGeminiReasoningEffort(value: unknown): GeminiReasoningEffort | undefined {
  return kernels.normalizeGeminiReasoningEffort(value) as GeminiReasoningEffort | undefined;
}

export type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};
export type GeminiContent = { role: string; parts: GeminiPart[] };

export function openAiMessagesToGeminiContents(messages: unknown[]): GeminiContent[] {
  return kernels.openAiMessagesToGeminiContents(messages) as GeminiContent[];
}

export function extractSystemInstructions(messages: unknown[]): string[] {
  return kernels.extractSystemInstructions(messages);
}

export function geminiResponseToChatCompletion(response: unknown, routedModel: string): Record<string, unknown> {
  return kernels.geminiResponseToChatCompletion(response, routedModel);
}

export function geminiPayloadToSdkRequest(model: string, payload: Record<string, unknown>): { model: string; contents: GeminiContent[]; config: Record<string, unknown> } {
  return kernels.geminiPayloadToSdkRequest(model, payload) as { model: string; contents: GeminiContent[]; config: Record<string, unknown> };
}

export class GeminiChatProviderStrategy extends BaseProviderStrategy implements DirectExecutionProviderStrategy {
  public readonly mode = "gemini_chat" as const;

  public readonly isLocal = false;
  public readonly registryId: string = "gemini-chat";

  public getUpstreamPath(context: StrategyRequestContext): string {
    const manifestPath = context.config.cljsPolicyManifestPath;
    const providerId = (context as { providerId?: string }).providerId ?? context.routeProviderId ?? "gemini";
    const alias = resolveModelAliasWithCljs({
      manifestPath,
      modelId: context.routedModel,
      providerId,
    });
    return kernels.geminiUpstreamPath(alias, context.routedModel);
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const payload = kernels.buildGeminiPayload(buildRequestBodyForUpstream(context), context.routedModel);
    return buildPayloadResult(payload, context);
  }

  public applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    // Gemini uses API key auth (X-Goog-Api-Key header) rather than OpenAI bearer headers.
    headers.delete("authorization");
    headers.set("x-goog-api-key", context.account.token);
    headers.set("content-type", "application/json");
  }

  public async executeDirect(
    reply: FastifyReply,
    context: ProviderAttemptContext,
    payload: Record<string, unknown>,
  ): Promise<ProviderAttemptOutcome> {
    const apiKey = context.account.token;
    if (!apiKey) {
      return { kind: "continue", requestError: true };
    }

    const baseUrl = context.baseUrl;
    if (kernels.isLocalGeminiBaseUrl(baseUrl)) {
      const headers = new Headers();
      this.applyRequestHeaders(headers, context, payload);
      const upstreamResponse = await fetch(joinUrl(baseUrl, this.getUpstreamPath(context)), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      return await this.handleProviderAttempt(reply, upstreamResponse, context);
    }

    const genAI = new GoogleGenAI({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    
    const manifestPath = context.config.cljsPolicyManifestPath;
    const providerId = context.providerId ?? context.routeProviderId ?? "gemini";
    const alias = resolveModelAliasWithCljs({
      manifestPath,
      modelId: context.routedModel,
      providerId,
    });
    const model = alias ?? context.routedModel;

    // Defensive: don't call the Gemini SDK with non-Gemini models.
    // The policy engine should filter providers by model family, but
    // when it doesn't (e.g. TS fallback path), this prevents poisoning
    // the routing accumulator with upstreamInvalidRequest.
    if (!kernels.isGeminiSdkModel(model)) {
      return { kind: "continue", modelNotFound: true };
    }

    try {
      const sdkRequest = geminiPayloadToSdkRequest(model, payload);

      if (context.clientWantsStream) {
        // Handle streaming
        const streamResult = await genAI.models.generateContentStream(sdkRequest);

        // Convert stream to SSE
        reply.code(200);
        reply.header("content-type", "text/event-stream; charset=utf-8");
        reply.header("cache-control", "no-cache");
        reply.header("x-accel-buffering", "no");
        reply.header("x-open-hax-upstream-provider", context.providerId);
        reply.hijack();
        
        const rawResponse = reply.raw;
        rawResponse.statusCode = 200;
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) {
            rawResponse.setHeader(name, value as never);
          }
        }
        rawResponse.flushHeaders();

        try {
          const accumulator = kernels.createGeminiStreamAccumulator();
          for await (const chunk of streamResult) {
            accumulator.push(chunk);
          }

          // Text, reasoning and any function calls are reassembled into one completion.
          const chatCompletion = accumulator.completion(context.routedModel);

          // Send final completion as SSE
          const sseData = chatCompletionToSse(chatCompletion);
          rawResponse.write(sseData);
        } catch (error) {
          if (!rawResponse.writableEnded) {
            rawResponse.write(`data: ${JSON.stringify({ error: { message: String(error) } })}\n\n`);
          }
        }

        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
        
        return { kind: "handled" };
      } else {
        // Non-streaming request
        const response = await genAI.models.generateContent(sdkRequest);

        const chatCompletion = geminiResponseToChatCompletion(response as unknown as Record<string, unknown>, context.routedModel);

        // Check reasoning trace requirement
        if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
          return { kind: "continue", requestError: true };
        }

        reply.header("x-open-hax-upstream-provider", context.providerId);
        reply.code(200);
        reply.header("content-type", "application/json");
        reply.send(chatCompletion);
        
        return { kind: "handled" };
      }
    } catch (error) {
      // Handle specific Gemini SDK errors
      return kernels.classifyGeminiSdkError(String(error));
    }
  }

  public override async handleProviderAttempt(
    reply: FastifyReply,
    upstreamResponse: Response,
    context: ProviderAttemptContext,
  ): Promise<ProviderAttemptOutcome> {
    // This should not be called when executeDirect is implemented,
    // but provide a fallback just in case.
    if (!upstreamResponse.ok) {
      return this.handleStandardProviderAttempt(reply, upstreamResponse, context);
    }

    let upstreamJson: unknown;
    try {
      upstreamJson = await upstreamResponse.json();
    } catch {
      return { kind: "continue", requestError: true };
    }

    const chatCompletion = geminiResponseToChatCompletion(upstreamJson, context.routedModel);

    if (context.needsReasoningTrace && !chatCompletionHasReasoningContent(chatCompletion) && context.hasMoreCandidates) {
      return { kind: "continue", requestError: true };
    }

    reply.header("x-open-hax-upstream-provider", context.providerId);
    if (context.clientWantsStream) {
      reply.code(200);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      reply.send(chatCompletionToSse(chatCompletion));
      return { kind: "handled" };
    }

    reply.code(upstreamResponse.status);
    reply.header("content-type", "application/json");
    reply.send(chatCompletion);
    return { kind: "handled" };
  }
}
