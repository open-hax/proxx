/**
 * OpenAI-specific request and response handling utilities.
 */

import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";
import { isRecord, asString } from "../provider-utils.js";
import { openAiError } from "../proxy.js";

/**
 * Extract a prompt cache key from a request body.
 */
export function extractPromptCacheKey(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.prompt_cache_key === "string"
    ? body.prompt_cache_key
    : typeof body.promptCacheKey === "string"
      ? body.promptCacheKey
      : undefined;
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Hash a prompt cache key for safe logging.
 */
export function hashPromptCacheKey(promptCacheKey: string): string {
  const trimmed = promptCacheKey.trim();
  if (trimmed.length === 0) {
    return "<REDACTED>";
  }

  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

/**
 * Append a value to a CSV-style header, avoiding duplicates.
 */
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

/**
 * Check if interleaved thinking header should be enabled.
 */
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

/**
 * Check if a request wants reasoning trace in the response.
 */
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

/**
 * Send an OpenAI-formatted error response.
 */
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

/**
 * Summarize a Responses API request body for logging.
 */
export function summarizeResponsesRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (typeof body.model === "string" && body.model.trim().length > 0) {
    summary.model = body.model;
  }

  if (typeof body.stream === "boolean") {
    summary.stream = body.stream;
  }

  if (typeof body.max_output_tokens === "number" && Number.isFinite(body.max_output_tokens)) {
    summary.max_output_tokens = body.max_output_tokens;
  }

  const input = body.input;
  if (typeof input === "string") {
    summary.input = { kind: "text", length: input.length, preview: input.slice(0, 200) };
    return summary;
  }

  if (!Array.isArray(input)) {
    summary.input = { kind: typeof input };
    return summary;
  }

  let textChars = 0;
  let firstTextPreview: string | undefined;
  let imageCount = 0;

  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }

    const content = item.content;
    if (typeof content === "string") {
      textChars += content.length;
      if (firstTextPreview === undefined && content.length > 0) {
        firstTextPreview = content.slice(0, 200);
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }

      const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
      const text = typeof part.text === "string" ? part.text : undefined;

      if (text) {
        textChars += text.length;
        if (firstTextPreview === undefined && text.length > 0) {
          firstTextPreview = text.slice(0, 200);
        }
      }

      if (partType.includes("image") || part.image_url !== undefined || part.imageUrl !== undefined) {
        imageCount += 1;
      }
    }
  }

  summary.input = {
    kind: "structured",
    itemCount: input.length,
    textChars,
    textPreview: firstTextPreview,
    imageCount,
  };

  return summary;
}
