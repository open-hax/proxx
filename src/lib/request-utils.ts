import type { FastifyReply } from "fastify";

import { kernels } from "./cljs-kernels.js";

export const PROXY_AUTH_COOKIE_NAME = "open_hax_proxy_auth_token";

export const readCookieToken = (cookieHeader: string | undefined, name: string): string | undefined =>
  kernels.readCookieToken(cookieHeader, name) ?? undefined;

export const parseJsonIfPossible = (body: string): unknown => kernels.parseJsonIfPossible(body) ?? undefined;

export const readSingleHeader = (headers: Record<string, unknown>, name: string): string | undefined =>
  kernels.readSingleHeader(headers, name) ?? undefined;

export const escapeHtml = (value: string): string => kernels.escapeHtml(value);

export const normalizeRequestedModel = (value: unknown): string | undefined =>
  kernels.normalizeRequestedModel(value) ?? undefined;

export const isTrustedLocalBridgeAddress = (remoteAddress: string | undefined): boolean =>
  kernels.isTrustedLocalBridgeAddress(remoteAddress);

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
