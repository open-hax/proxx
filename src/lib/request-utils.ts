import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";
import { isRecord } from "./provider-utils.js";

export const PROXY_AUTH_COOKIE_NAME = "open_hax_proxy_auth_token";

export function readCookieToken(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) {
      continue;
    }

    const rawValue = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

export function extractPromptCacheKey(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.prompt_cache_key === "string"
    ? body.prompt_cache_key
    : typeof body.promptCacheKey === "string"
      ? body.promptCacheKey
      : undefined;
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function hashPromptCacheKey(promptCacheKey: string): string {
  const trimmed = promptCacheKey.trim();
  if (trimmed.length === 0) {
    return "<REDACTED>";
  }

  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

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

export function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const baseLower = normalizedBase.toLowerCase();
  const pathLower = normalizedPath.toLowerCase();
  if (pathLower.startsWith("/v1/") && baseLower.endsWith("/v1")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}

export function parseJsonIfPossible(body: string): unknown {
  if (body.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function readSingleHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.find((value) => typeof value === "string" && value.length > 0);
  }
  return undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeRequestedModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isTrustedLocalBridgeAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
}

export function copyInjectedResponseHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "undefined" || name.toLowerCase() === "content-length") {
      continue;
    }

    reply.header(name, value);
  }
}

export const SUPPORTED_V1_ENDPOINTS = [
  "POST /v1/chat/completions",
  "POST /v1/responses",
  "POST /v1/images/generations",
  "POST /v1/embeddings",
  "GET /v1/models",
  "GET /v1/models/:model"
] as const;

export const SUPPORTED_NATIVE_OLLAMA_ENDPOINTS = [
  "POST /api/chat",
  "POST /api/generate",
  "POST /api/embed",
  "POST /api/embeddings",
  "GET /api/tags"
] as const;

export interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: unknown;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

export interface WebSearchToolRequest {
  readonly query?: unknown;
  readonly numResults?: unknown;
  readonly searchContextSize?: unknown;
  readonly allowedDomains?: unknown;
  readonly model?: unknown;
}
