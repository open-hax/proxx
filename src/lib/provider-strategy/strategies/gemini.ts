import { GoogleGenAI } from "@google/genai";
import type { FastifyReply } from "fastify";

import { requestWantsReasoningTrace } from "../../openai/index.js";
import { resolveModelAliasWithCljs } from "../../cljs-runtime.js";
import { BaseProviderStrategy } from "../base.js";
import {
  asNumber,
  asString,
  buildPayloadResult,
  buildRequestBodyForUpstream,
  isRecord,
  openAiContentToText,
  type BuildPayloadResult,
  type DirectExecutionProviderStrategy,
  type ProviderAttemptContext,
  type ProviderAttemptOutcome,
  type StrategyRequestContext,
} from "../shared.js";
import { chatCompletionToSse } from "../../responses-compat.js";
import { chatCompletionHasReasoningContent } from "../../sse/index.js";

type GeminiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function normalizeGeminiReasoningEffort(value: unknown): GeminiReasoningEffort | undefined {
  const raw = asString(value)?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }

  switch (raw) {
    case "none":
    case "disable":
    case "disabled":
    case "off":
      return "none";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
    case "normal":
    case "auto":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "very_high":
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

function geminiReasoningEffort(body: Record<string, unknown>): GeminiReasoningEffort | undefined {
  const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
  return normalizeGeminiReasoningEffort(
    reasoning?.effort
      ?? body.reasoning_effort
      ?? body.reasoningEffort,
  );
}

function buildGemini25ThinkingBudget(effort: GeminiReasoningEffort | undefined, minBudget: number, maxBudget: number, supportsOff: boolean): number {
  switch (effort) {
    case undefined:
      return -1;
    case "none":
      return supportsOff ? 0 : minBudget;
    case "minimal":
      return minBudget;
    case "low":
      return Math.max(minBudget, Math.min(maxBudget, Math.floor(maxBudget * 0.25)));
    case "medium":
      return Math.max(minBudget, Math.min(maxBudget, Math.floor(maxBudget * 0.5)));
    case "high":
      return Math.max(minBudget, Math.min(maxBudget, Math.floor(maxBudget * 0.75)));
    case "xhigh":
      return maxBudget;
  }
}

function buildGemini3ThinkingLevel(model: string, effort: GeminiReasoningEffort | undefined): string {
  const lower = model.toLowerCase();
  const isFlash = lower.includes("flash");

  if (isFlash) {
    switch (effort) {
      case undefined:
      case "medium":
        return "MEDIUM";
      case "none":
      case "minimal":
        return "MINIMAL";
      case "low":
        return "LOW";
      case "high":
      case "xhigh":
        return "HIGH";
    }
  }

  switch (effort) {
    case undefined:
    case "none":
    case "minimal":
    case "low":
    case "medium":
      return "LOW";
    case "high":
    case "xhigh":
      return "HIGH";
  }
}

function buildGeminiThinkingConfig(body: Record<string, unknown>, model: string): Record<string, unknown> | undefined {
  const effort = geminiReasoningEffort(body);
  const wantsReasoningTrace = requestWantsReasoningTrace(body);
  if (!wantsReasoningTrace && effort === undefined) {
    return undefined;
  }

  const lower = model.toLowerCase();
  const thinkingConfig: Record<string, unknown> = {};

  if (lower.startsWith("gemini-2.5-flash")) {
    thinkingConfig.thinkingBudget = buildGemini25ThinkingBudget(effort, 1024, 24576, true);
  } else if (lower.startsWith("gemini-2.5-pro")) {
    thinkingConfig.thinkingBudget = buildGemini25ThinkingBudget(effort, 128, 32768, false);
  } else if (lower.startsWith("gemini-3")) {
    thinkingConfig.thinkingLevel = buildGemini3ThinkingLevel(model, effort);
  } else {
    return undefined;
  }

  if (wantsReasoningTrace) {
    thinkingConfig.includeThoughts = true;
  }

  return thinkingConfig;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};
export type GeminiContent = { role: string; parts: GeminiPart[] };

// OpenAI tool_calls carry arguments as a JSON string; Gemini functionCall.args is an object.
function parseToolCallArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) {
    return raw;
  }
  const text = asString(raw);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

// OpenAI tool-result content is typically a string; Gemini functionResponse.response must be an object.
function buildFunctionResponsePayload(content: unknown): Record<string, unknown> {
  const text = openAiContentToText(content);
  if (text.length === 0) {
    return { result: "" };
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { result: parsed };
  } catch {
    return { result: text };
  }
}

export function openAiMessagesToGeminiContents(messages: unknown[]): GeminiContent[] {
  const contents: GeminiContent[] = [];

  // Tool-result messages may omit the function name, so map tool_call_id -> name
  // from the assistant tool_calls that requested them.
  const toolCallNames = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isRecord(call)) {
        continue;
      }
      const id = asString(call.id);
      const fn = isRecord(call.function) ? call.function : undefined;
      const name = fn ? asString(fn.name) : undefined;
      if (id && name) {
        toolCallNames.set(id, name);
      }
    }
  }

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    const role = asString(message.role)?.trim().toLowerCase() ?? "";

    if (role === "system") {
      // System messages are handled separately via systemInstruction
      continue;
    }

    if (role === "user") {
      const text = openAiContentToText(message.content).trim();
      if (text.length > 0) {
        contents.push({ role: "user", parts: [{ text }] });
      }
      continue;
    }

    if (role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = openAiContentToText(message.content).trim();
      if (text.length > 0) {
        parts.push({ text });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isRecord(call)) {
            continue;
          }
          const fn = isRecord(call.function) ? call.function : undefined;
          const name = fn ? asString(fn.name) : undefined;
          if (!name) {
            continue;
          }
          parts.push({ functionCall: { name, args: parseToolCallArguments(fn?.arguments) } });
        }
      }
      // Gemini Content.role only accepts "user"/"model"; assistant -> model.
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      const toolCallId = asString(message.tool_call_id);
      const name = asString(message.name)
        ?? (toolCallId ? toolCallNames.get(toolCallId) : undefined)
        ?? "tool";
      // Function responses are sent back under role "user" (Gemini has no tool role).
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: buildFunctionResponsePayload(message.content) } }],
      });
      continue;
    }
  }

  return contents;
}

export function extractSystemInstructions(messages: unknown[]): string[] {
  const systemParts: string[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    const role = asString(message.role)?.trim().toLowerCase() ?? "";
    if (role !== "system") {
      continue;
    }

    const text = openAiContentToText(message.content).trim();
    if (text.length > 0) {
      systemParts.push(text);
    }
  }

  return systemParts;
}

function extractToolCalls(parts: unknown[]): Array<Record<string, unknown>> | undefined {
  const toolCalls: Array<Record<string, unknown>> = [];
  let callIndex = 0;

  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }

    const functionCall = isRecord(part.functionCall) ? part.functionCall : undefined;
    if (!functionCall) {
      continue;
    }

    const name = asString(functionCall.name);
    const args = functionCall.args;
    if (!name) {
      continue;
    }

    toolCalls.push({
      id: `call_gemini_${callIndex}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    });
    callIndex += 1;
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export function geminiResponseToChatCompletion(response: unknown, routedModel: string): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);

  if (!isRecord(response)) {
    return {
      id: `chatcmpl-gemini-${created}`,
      object: "chat.completion",
      created,
      model: routedModel,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    };
  }

  // The @google/genai SDK returns responses in a structured format
  // Extract text from candidates
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const firstCandidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;
  
  // Handle content from SDK response format
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const allParts: unknown[] = [];
  
  if (firstCandidate) {
    const content = isRecord(firstCandidate.content) ? firstCandidate.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    allParts.push(...parts);
    
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      
      // Skip function call parts - they are handled separately
      if (part.functionCall) {
        continue;
      }
      
      const text = asString(part.text)?.trim() ?? "";
      if (text.length === 0) {
        continue;
      }
      
      if (part.thought === true) {
        reasoningParts.push(text);
        continue;
      }
      
      textParts.push(text);
    }
  }

  const text = textParts.join("\n").trim();
  const reasoningContent = reasoningParts.join("\n").trim();
  const toolCalls = extractToolCalls(allParts);

  const finishReasonRaw = firstCandidate ? asString(firstCandidate.finishReason) ?? asString(firstCandidate.finish_reason) : undefined;
  const finishReason = finishReasonRaw
    ? finishReasonRaw.toLowerCase() === "stop"
      ? "stop"
      : finishReasonRaw.toLowerCase() === "max_tokens"
        ? "length"
        : "stop"
    : "stop";

  // Extract usage metadata
  const usageMetadata = isRecord(response.usageMetadata) ? response.usageMetadata : null;
  const promptTokens = usageMetadata ? asNumber(usageMetadata.promptTokenCount) : undefined;
  const completionTokens = usageMetadata ? asNumber(usageMetadata.candidatesTokenCount) : undefined;
  const totalTokens = usageMetadata ? asNumber(usageMetadata.totalTokenCount) : undefined;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls ? (text || null) : text,
  };

  if (reasoningContent.length > 0) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-gemini-${created}`,
    object: "chat.completion",
    created,
    model: routedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
      ? {
          usage: {
            ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
            ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
            ...(totalTokens !== undefined
              ? { total_tokens: totalTokens }
              : promptTokens !== undefined && completionTokens !== undefined
                ? { total_tokens: promptTokens + completionTokens }
                : {}),
          },
        }
      : {}),
  };
}

export function geminiPayloadToSdkRequest(model: string, payload: Record<string, unknown>): { model: string; contents: GeminiContent[]; config: Record<string, unknown> } {
  const contents = Array.isArray(payload.contents)
    ? payload.contents as GeminiContent[]
    : [];
  const systemInstruction = isRecord(payload.systemInstruction)
    ? payload.systemInstruction as { parts?: unknown }
    : undefined;
  const generationConfig = isRecord(payload.generationConfig)
    ? payload.generationConfig
    : undefined;

  // Preserve all part shapes (text, functionCall, functionResponse) — do NOT
  // remap to { text } only, which would silently drop tool-call/result parts.
  const sdkContents = contents.map((content) => ({
    role: content.role,
    parts: [...content.parts],
  }));

  const config: Record<string, unknown> = {};

  if (generationConfig) {
    if (generationConfig.temperature !== undefined) {
      config.temperature = generationConfig.temperature;
    }
    if (generationConfig.maxOutputTokens !== undefined) {
      config.maxOutputTokens = generationConfig.maxOutputTokens;
    }
    if (generationConfig.thinkingConfig) {
      config.thinkingConfig = generationConfig.thinkingConfig;
    }
  }

  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    const systemText = systemInstruction.parts
      .filter(isRecord)
      .map((part) => asString(part.text) ?? "")
      .join("\n\n");
    if (systemText) {
      config.systemInstruction = systemText;
    }
  }

  if (Array.isArray(payload.tools)) {
    config.tools = payload.tools;
  }

  if (isRecord(payload.toolConfig)) {
    config.toolConfig = payload.toolConfig;
  }

  return { model, contents: sdkContents, config };
}

export function classifyGeminiSdkError(errorMessage: string): ProviderAttemptOutcome {
  if (
    errorMessage.includes("rate limit")
    || errorMessage.includes("RATE_LIMIT")
    || errorMessage.includes("UNAVAILABLE")
    || errorMessage.includes("503")
  ) {
    return { kind: "continue", rateLimit: true };
  }

  if (errorMessage.includes("model not found") || errorMessage.includes("MODEL_NOT_FOUND")) {
    return { kind: "continue", modelNotFound: true };
  }

  if (errorMessage.includes("not supported") || errorMessage.includes("NOT_SUPPORTED")) {
    return { kind: "continue", modelNotSupportedForAccount: true, requestError: true };
  }

  if (errorMessage.includes("invalid request") || errorMessage.includes("INVALID_ARGUMENT")) {
    return { kind: "continue", requestError: true, upstreamInvalidRequest: true };
  }

  return { kind: "continue", requestError: true };
}

export class GeminiChatProviderStrategy extends BaseProviderStrategy implements DirectExecutionProviderStrategy {
  public readonly mode = "gemini_chat" as const;

  public readonly isLocal = false;

  public matches(_context: StrategyRequestContext): boolean {
    return _context.routeProviderId === "gemini"
      && _context.responsesPassthrough !== true
      && _context.imagesPassthrough !== true;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    const manifestPath = context.config.cljsPolicyManifestPath;
    const providerId = (context as { providerId?: string }).providerId ?? context.routeProviderId ?? "gemini";
    const alias = resolveModelAliasWithCljs({
      manifestPath,
      modelId: context.routedModel,
      providerId,
    });
    const model = encodeURIComponent(alias ?? context.routedModel);
    return `/models/${model}:generateContent`;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamBody = buildRequestBodyForUpstream(context);
    const rawMessages = Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [];

    const contents = openAiMessagesToGeminiContents(rawMessages);
    const systemParts = extractSystemInstructions(rawMessages);

    const generationConfig: Record<string, unknown> = {};
    const temperature = asNumber(upstreamBody.temperature);
    if (temperature !== undefined) {
      generationConfig.temperature = temperature;
    }
    const maxTokens = asNumber(upstreamBody.max_output_tokens)
      ?? asNumber(upstreamBody.max_tokens)
      ?? asNumber(upstreamBody.maxTokens);
    if (maxTokens !== undefined) {
      generationConfig.maxOutputTokens = maxTokens;
    }

    const thinkingConfig = buildGeminiThinkingConfig(upstreamBody, context.routedModel);
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    const payload: Record<string, unknown> = {
      contents,
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemParts.join("\n\n") }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    // Transform OpenAI tools to Gemini function declarations
    const tools = upstreamBody.tools;
    if (Array.isArray(tools)) {
      const functionDeclarations: Array<Record<string, unknown>> = [];
      for (const tool of tools) {
        if (!isRecord(tool)) {
          continue;
        }
        const toolType = asString(tool.type);
        if (toolType !== "function") {
          continue;
        }
        const func = isRecord(tool.function) ? tool.function : undefined;
        if (!func) {
          continue;
        }
        const name = asString(func.name);
        if (!name) {
          continue;
        }
        const declaration: Record<string, unknown> = { name };
        const description = asString(func.description);
        if (description) {
          declaration.description = description;
        }
        const parameters = func.parameters;
        if (isRecord(parameters)) {
          declaration.parameters = parameters;
        }
        functionDeclarations.push(declaration);
      }
      if (functionDeclarations.length > 0) {
        payload.tools = [{ functionDeclarations }];
      }
    }

    // Transform OpenAI tool_choice to Gemini toolConfig
    const toolChoice = upstreamBody.tool_choice;
    if (typeof toolChoice === "string") {
      let mode: string;
      switch (toolChoice) {
        case "none":
          mode = "NONE";
          break;
        case "required":
          mode = "ANY";
          break;
        case "auto":
        default:
          mode = "AUTO";
          break;
      }
      payload.toolConfig = {
        functionCallingConfig: { mode },
      };
    } else if (isRecord(toolChoice)) {
      const choiceType = asString(toolChoice.type);
      if (choiceType === "function") {
        const func = isRecord(toolChoice.function) ? toolChoice.function : undefined;
        const name = func ? asString(func.name) : undefined;
        if (name) {
          payload.toolConfig = {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: [name],
            },
          };
        }
      }
    }

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
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(baseUrl)) {
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
    if (!model.startsWith("gemini-") && !model.startsWith("models/") && !model.includes("gemma")) {
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

        // Extend queue timeout now that streaming has started successfully
        const signal = context.queueSignal;
        if (signal && typeof (signal as any).extendTimeout === "function") {
          (signal as any).extendTimeout();
        }

        // Emit SSE error if the queue aborts us mid-stream
        if (signal) {
          const onAbort = () => {
            if (!rawResponse.writableEnded) {
              rawResponse.write(
                `data: ${JSON.stringify({
                  error: { message: "Provider stream aborted by request queue timeout" },
                })}\n\n`
              );
              rawResponse.end();
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }

        try {
          let accumulatedText = "";
          let accumulatedReasoning = "";
          const functionCallParts: Array<Record<string, unknown>> = [];

          for await (const chunk of streamResult) {
            const chunkData = chunk as unknown as Record<string, unknown>;
            const candidates = Array.isArray(chunkData.candidates) ? chunkData.candidates : [];
            const firstCandidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;
            const content = firstCandidate && isRecord(firstCandidate.content) ? firstCandidate.content : undefined;
            const parts = content && Array.isArray(content.parts) ? content.parts : [];

            for (const part of parts) {
              if (!isRecord(part)) {
                continue;
              }
              // Accumulate function-call parts so streamed tool calls are not lost.
              if (part.functionCall) {
                functionCallParts.push(part);
                continue;
              }
              const partText = asString(part.text) ?? "";
              if (!partText) {
                continue;
              }
              if (part.thought === true) {
                accumulatedReasoning += partText;
              } else {
                accumulatedText += partText;
              }
            }
          }

          // Reassemble parts so geminiResponseToChatCompletion sees text, reasoning,
          // and any function calls (which it maps to OpenAI tool_calls).
          const finalParts: Array<Record<string, unknown>> = [];
          if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
          }
          if (accumulatedReasoning) {
            finalParts.push({ text: accumulatedReasoning, thought: true });
          }
          finalParts.push(...functionCallParts);

          // Send final completion as SSE
          const chatCompletion = geminiResponseToChatCompletion({
            candidates: [{
              content: {
                parts: finalParts.length > 0 ? finalParts : [{ text: "" }],
              },
              finishReason: "STOP",
            }],
          }, context.routedModel);

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
      return classifyGeminiSdkError(String(error));
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
