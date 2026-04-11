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
