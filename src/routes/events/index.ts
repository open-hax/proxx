import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";

export async function registerEventRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<void> {
  app.get<{
    Querystring: {
      kind?: string;
      entry_id?: string;
      provider_id?: string;
      model?: string;
      status?: string;
      status_gte?: string;
      status_lt?: string;
      tag?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/v1/events", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available (no database connection)" });
      return;
    }

    const q = request.query;
    const events = await deps.eventStore.query({
      kind: q.kind as "request" | "response" | "error" | "label" | "metric" | undefined,
      entryId: q.entry_id,
      providerId: q.provider_id,
      model: q.model,
      status: q.status ? Number.parseInt(q.status, 10) : undefined,
      statusGte: q.status_gte ? Number.parseInt(q.status_gte, 10) : undefined,
      statusLt: q.status_lt ? Number.parseInt(q.status_lt, 10) : undefined,
      tag: q.tag,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: q.limit ? Number.parseInt(q.limit, 10) : 50,
      offset: q.offset ? Number.parseInt(q.offset, 10) : undefined,
    });

    reply.send({ events, count: events.length });
  });

  app.get("/api/v1/events/tags", async (_request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const tags = await deps.eventStore.countByTag(since);
    reply.send({ tags, since: since.toISOString() });
  });

  app.post<{
    Params: { id: string };
    Body: { tag: string };
  }>("/api/v1/events/:id/tag", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const tag = typeof request.body === "object" && request.body !== null && "tag" in request.body
      ? String((request.body as Record<string, unknown>).tag)
      : undefined;
    if (!tag) {
      reply.code(400).send({ error: "Missing tag field" });
      return;
    }

    await deps.eventStore.addTag(request.params.id, tag);
    reply.send({ ok: true });
  });

  app.delete<{
    Params: { id: string };
    Body: { tag: string };
  }>("/api/v1/events/:id/tag", async (request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const tag = typeof request.body === "object" && request.body !== null && "tag" in request.body
      ? String((request.body as Record<string, unknown>).tag)
      : undefined;
    if (!tag) {
      reply.code(400).send({ error: "Missing tag field" });
      return;
    }

    await deps.eventStore.removeTag(request.params.id, tag);
    reply.send({ ok: true });
  });
}
