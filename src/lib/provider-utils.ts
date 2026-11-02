import type { FastifyReply } from "fastify";

import { kernels } from "./cljs-kernels.js";
import { getActiveCljsRuntime } from "./cljs-runtime.js";

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

export const hasBearerToken = (header: string | undefined, expectedToken: string): boolean =>
  kernels.hasBearerToken(header, expectedToken);

export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type: string,
  code?: string
): void {
  kernels.sendOpenAiError(reply, statusCode, message, type, code);
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

/** Answer a queue failure with its OpenAI-shaped error (proxx.runtime.proxy/send-queue-error-js). */
export function sendQueueError(reply: FastifyReply, error: unknown): boolean {
  return kernels.sendQueueError(reply, error);
}
