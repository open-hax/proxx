import type { FastifyReply } from "fastify";

import { openAiError } from "./proxy.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function appendCsvHeaderValue(headers: Headers, name: string, value: string): void {
  const existing = headers.get(name);
  if (!existing) {
    headers.set(name, value);
    return;
  }

  const existingTokens = existing
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (existingTokens.includes(value)) {
    return;
  }

  headers.set(name, `${existing}, ${value}`);
}

export function shouldEnableInterleavedThinkingHeader(upstreamPayload: Record<string, unknown>): boolean {
  const thinking = isRecord(upstreamPayload["thinking"]) ? upstreamPayload["thinking"] : null;
  if (!thinking) {
    return false;
  }

  return asString(thinking["type"]) === "enabled";
}

function reasoningEffortIsDisabled(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "disable" || normalized === "disabled" || normalized === "off";
}

function includesReasoningTrace(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some((entry) => asString(entry) === "reasoning.encrypted_content");
}

export function requestWantsReasoningTrace(body: Record<string, unknown>): boolean {
  if (includesReasoningTrace(body["include"])) {
    return true;
  }

  const explicitThinking = isRecord(body["thinking"]) ? body["thinking"] : null;
  if (explicitThinking) {
    const type = asString(explicitThinking["type"]);
    if (type === "enabled") {
      return true;
    }

    if (type === "disabled") {
      return false;
    }
  }

  const reasoning = isRecord(body["reasoning"]) ? body["reasoning"] : null;
  const reasoningEffort = asString(reasoning?.["effort"])
    ?? asString(body["reasoning_effort"])
    ?? asString(body["reasoningEffort"]);

  if (reasoningEffort) {
    return !reasoningEffortIsDisabled(reasoningEffort);
  }

  return reasoning !== null;
}

function extractSseDataLines(payload: string): string[] {
  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
}

export function stripSseCommentLines(payload: string): string {
  return payload
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(":"))
    .join("\n");
}

export function streamPayloadHasReasoningTrace(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) {
        continue;
      }

      if (chatCompletionHasReasoningContent(parsed)) {
        return true;
      }

      const type = asString(parsed["type"]);
      if (
        type === "response.reasoning.delta"
        || type === "response.reasoning_text.delta"
        || type === "response.reasoning_summary.delta"
        || type === "response.reasoning_summary_text.delta"
        || type === "response.reasoning_summary_part.delta"
        || type === "response.reasoning_summary_part.added"
        || type === "response.reasoning_summary_part.done"
      ) {
        const delta = parsed["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          return true;
        }
        if (isRecord(delta) && typeof delta["text"] === "string" && delta["text"].length > 0) {
          return true;
        }
        const part = parsed["part"];
        if (isRecord(part) && typeof part["text"] === "string" && part["text"].length > 0) {
          return true;
        }
        if (typeof parsed["text"] === "string" && parsed["text"].length > 0) {
          return true;
        }
      }
    } catch {
      // ignore malformed stream fragments during validation
    }
  }
  return false;
}

export function streamPayloadHasSubstantiveChunks(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) {
        return true;
      }

      const type = asString(parsed["type"]);
      if (
        type === "response.reasoning.delta"
        || type === "response.reasoning_text.delta"
        || type === "response.reasoning_summary.delta"
        || type === "response.reasoning_summary_text.delta"
        || type === "response.reasoning_summary_part.delta"
        || type === "response.reasoning_summary_part.added"
        || type === "response.reasoning_summary_part.done"
      ) {
        const delta = parsed["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          return true;
        }

        if (isRecord(delta) && typeof delta["text"] === "string" && delta["text"].length > 0) {
          return true;
        }
        const part = parsed["part"];
        if (isRecord(part) && typeof part["text"] === "string" && part["text"].length > 0) {
          return true;
        }
        if (typeof parsed["text"] === "string" && parsed["text"].length > 0) {
          return true;
        }
        continue;
      }
    } catch {
      return true;
    }

    return true;
  }
  return false;
}

export function streamPayloadIndicatesQuotaError(payload: string): boolean {
  for (const data of extractSseDataLines(payload)) {
    if (data === "[DONE]") {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(data);
      if (!payloadLooksLikeError(parsed)) {
        continue;
      }

      const message = extractErrorMessage(parsed);
      if (message && messageIndicatesQuotaError(message)) {
        return true;
      }

      if (messageIndicatesQuotaError(data)) {
        return true;
      }
    } catch {
      if (messageIndicatesQuotaError(data)) {
        return true;
      }
    }
  }

  return false;
}

export function chatCompletionHasReasoningContent(completion: Record<string, unknown>): boolean {
  const topLevelReasoning = asString(completion["reasoning_content"]) ?? asString(completion["reasoning"]);
  if (topLevelReasoning && topLevelReasoning.length > 0) {
    return true;
  }

  const choices = Array.isArray(completion["choices"]) ? completion["choices"] : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }

    const message = isRecord(choice["message"]) ? choice["message"] : null;
    if (message) {
      const reasoning = asString(message["reasoning_content"]) ?? asString(message["reasoning"]);
      if (reasoning && reasoning.length > 0) {
        return true;
      }
    }

    const delta = isRecord(choice["delta"]) ? choice["delta"] : null;
    if (delta) {
      const reasoning = asString(delta["reasoning_content"]) ?? asString(delta["reasoning"]);
      if (reasoning && reasoning.length > 0) {
        return true;
      }
    }
  }

  return false;
}

export function hasBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (!header) {
    return false;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === expectedToken;
}

export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type: string,
  code?: string
): void {
  if (code) {
    reply.header("x-open-hax-error-code", code);
  }
  reply.code(statusCode).send(openAiError(message, type, code));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
