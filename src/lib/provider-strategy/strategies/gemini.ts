import { kernels } from "../../cljs-kernels.js";

type GeminiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/*
 * Request/response translation is pure data transformation in CLJS
 * (`proxx.strategy.gemini`); the SDK attempt is proxx.runtime.strategies.
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
