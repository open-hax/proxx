import type { FastifyReply } from "fastify";

import {
  responsesEventStreamToChatCompletion,
  responsesEventStreamToErrorPayload,
  streamResponsesSseToChatCompletionChunks,
} from "../../responses-compat.js";
import type { ProviderAttemptContext, ProviderAttemptOutcome } from "../shared.js";

export async function handleResponsesEventStreamAsChatCompletion(
  reply: FastifyReply,
  upstreamResponse: Response,
  context: ProviderAttemptContext,
): Promise<ProviderAttemptOutcome> {
  if (context.clientWantsStream && upstreamResponse.body) {
    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.code(200);
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");
    reply.hijack();
    const rawResponse = reply.raw;
    rawResponse.statusCode = 200;
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) {
        rawResponse.setHeader(name, value as never);
      }
    }
    rawResponse.flushHeaders();

    try {
      const result = await streamResponsesSseToChatCompletionChunks(
        upstreamResponse.body,
        { fallbackModel: context.routedModel, writeFn: (data) => rawResponse.write(data) },
      );
      if (result.sawError) {
        console.error("[responses-event-stream] upstream SSE error", { providerId: context.providerId, routedModel: context.routedModel });
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
        return { kind: "handled" };
      }
    } catch (err) {
      console.error("[responses-event-stream] stream read error", { providerId: context.providerId, message: err instanceof Error ? err.message : String(err) });
      void upstreamResponse.body?.cancel();
    }
    if (!rawResponse.writableEnded) {
      rawResponse.end();
    }
    return { kind: "handled" };
  }

  const streamText = await upstreamResponse.text();
  const upstreamError = responsesEventStreamToErrorPayload(streamText);
  if (upstreamError) {
    reply.header("x-open-hax-upstream-provider", context.providerId);
    reply.code(400);
    reply.header("content-type", "application/json");
    reply.send({ error: upstreamError });
    return { kind: "handled" };
  }

  let chatCompletion: Record<string, unknown>;
  try {
    chatCompletion = responsesEventStreamToChatCompletion(streamText, context.routedModel);
  } catch {
    return {
      kind: "continue",
      requestError: true,
    };
  }

  reply.header("x-open-hax-upstream-provider", context.providerId);
  reply.code(200);
  reply.header("content-type", "application/json");
  reply.send(chatCompletion);
  return { kind: "handled" };
}
