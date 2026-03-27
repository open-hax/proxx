import type { FastifyInstance } from "fastify";

import type { ChatRole } from "../../lib/session-store.js";
import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import type { SessionUiRouteContext } from "./context.js";
import { resolveSessionRoutePath } from "./prefix.js";

function toChatRole(value: unknown): ChatRole {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }

  return "user";
}

function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }

  return fallback;
}

export async function registerSessionUiRoutes(
  app: FastifyInstance,
  _deps: UiRouteDependencies,
  context: SessionUiRouteContext,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.get(resolveSessionRoutePath("/sessions", options), async (_request, reply) => {
    const sessions = await context.sessionStore.listSessions();
    reply.send({ sessions });
  });

  app.post<{ Body: { readonly title?: string } }>(resolveSessionRoutePath("/sessions", options), async (request, reply) => {
    const session = await context.sessionStore.createSession(request.body?.title);
    reply.code(201).send({ session });
  });

  app.get<{ Params: { readonly sessionId: string } }>(resolveSessionRoutePath("/sessions/:sessionId", options), async (request, reply) => {
    const session = await context.sessionStore.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.send({ session });
  });

  app.get<{ Params: { readonly sessionId: string } }>(resolveSessionRoutePath("/sessions/:sessionId/cache-key", options), async (request, reply) => {
    const session = await context.sessionStore.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.send({ sessionId: session.id, promptCacheKey: session.promptCacheKey });
  });

  app.post<{
    Params: { readonly sessionId: string };
    Body: { readonly role?: ChatRole; readonly content?: string; readonly reasoningContent?: string; readonly model?: string };
  }>(resolveSessionRoutePath("/sessions/:sessionId/messages", options), async (request, reply) => {
    const content = typeof request.body?.content === "string" ? request.body.content : "";
    if (content.trim().length === 0) {
      reply.code(400).send({ error: "message_content_required" });
      return;
    }

    try {
      const { session, message } = await context.sessionStore.appendMessage(request.params.sessionId, {
        role: toChatRole(request.body?.role),
        content,
        reasoningContent: typeof request.body?.reasoningContent === "string" ? request.body.reasoningContent : undefined,
        model: request.body?.model,
      });

      await context.sessionIndex.indexMessage({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });

      reply.code(201).send({ message, sessionId: session.id });
    } catch (error) {
      reply.code(404).send({ error: "session_not_found", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Params: { readonly sessionId: string };
    Body: { readonly messageId?: string };
  }>(resolveSessionRoutePath("/sessions/:sessionId/fork", options), async (request, reply) => {
    try {
      const session = await context.sessionStore.forkSession(request.params.sessionId, request.body?.messageId);

      for (const message of session.messages) {
        await context.sessionIndex.indexMessage({
          sessionId: session.id,
          sessionTitle: session.title,
          messageId: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        });
      }

      reply.code(201).send({ session });
    } catch (error) {
      reply.code(404).send({ error: "fork_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly query?: string; readonly limit?: number };
  }>(resolveSessionRoutePath("/sessions/search", options), async (request, reply) => {
    await context.ensureInitialSemanticIndexSync();

    const query = typeof request.body?.query === "string" ? request.body.query.trim() : "";
    if (query.length === 0) {
      reply.send({ source: "none", results: [] });
      return;
    }

    const limit = toSafeLimit(request.body?.limit, 8, 50);
    const semantic = await context.sessionIndex.search(query, limit);
    if (semantic.length > 0) {
      reply.send({ source: "chroma", results: semantic });
      return;
    }

    const fallback = await context.sessionStore.searchLexical(query, limit);
    reply.send({
      source: "fallback",
      results: fallback.map((result) => ({
        ...result,
        distance: 0,
      })),
    });
  });
}
