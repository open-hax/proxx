import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../../types.js";

export async function registerEventRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<void> {
  app.get("/api/ui/events/tags", async (_request, reply) => {
    if (!deps.eventStore) {
      reply.code(503).send({ error: "Event store not available" });
      return;
    }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days
    const tags = await deps.eventStore.countByTag(since);
    reply.send({ tags, since: since.toISOString() });
  });

  app.post<{
    Params: { id: string };
    Body: { tag: string };
  }>("/api/ui/events/:id/tag", async (request, reply) => {
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
  }>("/api/ui/events/:id/tag", async (request, reply) => {
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
