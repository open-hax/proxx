import { TransformedJsonProviderStrategy } from "../base.js";
import {
  asNumber,
  asString,
  buildPayloadResult,
  buildRequestBodyForUpstream,
  isRecord,
  openAiContentToText,
  type BuildPayloadResult,
  type ProviderAttemptContext,
  type StrategyRequestContext,
} from "../shared.js";

export class GeminiChatProviderStrategy extends TransformedJsonProviderStrategy {
  public readonly mode = "gemini_chat" as const;

  public readonly isLocal = false;

  public matches(_context: StrategyRequestContext): boolean {
    // Selected explicitly in selectRemoteProviderStrategyForRoute for providerId === "gemini".
    return false;
  }

  public getUpstreamPath(context: StrategyRequestContext): string {
    const model = encodeURIComponent(context.routedModel);
    return `/models/${model}:generateContent`;
  }

  public buildPayload(context: StrategyRequestContext): BuildPayloadResult {
    const upstreamBody = buildRequestBodyForUpstream(context);
    const rawMessages = Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [];

    const contents: Array<{ readonly role: string; readonly parts: Array<{ readonly text: string }> }> = [];
    const systemParts: string[] = [];

    for (const message of rawMessages) {
      if (!isRecord(message)) {
        continue;
      }

      const role = asString(message.role)?.trim().toLowerCase() ?? "";
      const text = openAiContentToText(message.content).trim();
      if (text.length === 0) {
        continue;
      }

      if (role === "system") {
        systemParts.push(text);
        continue;
      }

      if (role === "user") {
        contents.push({ role: "user", parts: [{ text }] });
        continue;
      }

      if (role === "assistant") {
        contents.push({ role: "model", parts: [{ text }] });
        continue;
      }
    }

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

    return buildPayloadResult(payload, context);
  }

  public override applyRequestHeaders(headers: Headers, context: ProviderAttemptContext, _payload: Record<string, unknown>): void {
    // Gemini uses API key auth (X-Goog-Api-Key header) rather than OpenAI bearer headers.
    headers.delete("authorization");
    headers.set("x-goog-api-key", context.account.token);
    headers.set("content-type", "application/json");
  }

  protected convertResponseToChatCompletion(upstreamJson: unknown, routedModel: string): Record<string, unknown> {
    const created = Math.floor(Date.now() / 1000);

    if (!isRecord(upstreamJson)) {
      return {
        id: `chatcmpl-gemini-${created}`,
        object: "chat.completion",
        created,
        model: routedModel,
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      };
    }

    const candidates = Array.isArray(upstreamJson.candidates) ? upstreamJson.candidates : [];
    const firstCandidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;
    const candidateContent = firstCandidate && isRecord(firstCandidate.content) ? firstCandidate.content : undefined;
    const parts = candidateContent && Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
    const text = parts
      .map((part) => (isRecord(part) ? asString(part.text) ?? "" : ""))
      .join("")
      .trim();

    const finishReasonRaw = firstCandidate ? asString(firstCandidate.finishReason) ?? asString(firstCandidate.finish_reason) : undefined;
    const finishReason = finishReasonRaw
      ? finishReasonRaw.toLowerCase() === "stop"
        ? "stop"
        : finishReasonRaw.toLowerCase() === "max_tokens"
          ? "length"
          : "stop"
      : "stop";

    const usageMetadata = isRecord(upstreamJson.usageMetadata) ? upstreamJson.usageMetadata : null;
    const promptTokens = usageMetadata ? asNumber(usageMetadata.promptTokenCount) : undefined;
    const completionTokens = usageMetadata ? asNumber(usageMetadata.candidatesTokenCount) : undefined;
    const totalTokens = usageMetadata ? asNumber(usageMetadata.totalTokenCount) : undefined;

    return {
      id: `chatcmpl-gemini-${created}`,
      object: "chat.completion",
      created,
      model: routedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
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
}

