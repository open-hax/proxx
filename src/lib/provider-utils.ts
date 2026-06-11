import type { FastifyReply } from "fastify";

import { getActiveCljsRuntime } from "./cljs-runtime.js";
import { openAiError } from "./proxy.js";

export class OpenAiHttpError extends Error {
  public readonly statusCode: number;
  public readonly type: string;
  public readonly code?: string;
  public readonly meta?: Record<string, unknown>;

  public constructor(input: {
    readonly statusCode: number;
    readonly message: string;
    readonly type: string;
    readonly code?: string;
    readonly meta?: Record<string, unknown>;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "OpenAiHttpError";
    this.statusCode = input.statusCode;
    this.type = input.type;
    this.code = input.code;
    this.meta = input.meta;
  }
}

export function isOpenAiHttpError(error: unknown): error is OpenAiHttpError {
  return error instanceof OpenAiHttpError;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function errorData(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return isRecord(error.data) ? error.data : undefined;
}

function keywordName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.replace(/^:/, "");
  }
  if (isRecord(value) && typeof value.name === "string") {
    const namespace = typeof value.ns === "string" ? `${value.ns}/` : "";
    return `${namespace}${value.name}`;
  }
  return value === undefined || value === null ? undefined : String(value).replace(/^:/, "");
}

export async function runCljsQueued<T>(
  manifestPath: string | undefined,
  queueContext: Record<string, unknown>,
  task: (controller: AbortController) => Promise<T>,
): Promise<T> {
  const runtime = getActiveCljsRuntime();
  if (manifestPath && runtime?.runQueued) {
    return await runtime.runQueued(manifestPath, queueContext, task);
  }
  return await task(new AbortController());
}

export function sendQueueError(reply: FastifyReply, error: unknown): boolean {
  const data = errorData(error);
  const code = keywordName(data?.code);

  function setRetryAfter(): void {
    const retryAfterMs = data?.["retry-after-ms"] ?? data?.retryAfterMs;
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
  }

  if (code === "queue/full") {
    setRetryAfter();
    sendOpenAiError(reply, 429, "Request queue full", "server_error", "queue_full");
    return true;
  }
  if (code === "queue/dropped" || code === "queue/total-timeout" || code === "queue/attempt-timeout" || code === "queue/exhausted") {
    setRetryAfter();
    sendOpenAiError(reply, 429, "Request queue dropped or timed out", "server_error", "queue_dropped");
    return true;
  }
  return false;
}
