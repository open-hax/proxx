import type { FastifyInstance } from "fastify";
import { toOpenAiModel } from "../lib/models.js";
import { sendOpenAiError } from "../lib/provider-utils.js";
import type { AppDeps } from "../lib/app-deps.js";

export function registerModelsRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.get("/v1/models", async (_request, reply) => {
    const modelIds = await deps.getMergedModelIds();
    reply.send({
      object: "list",
      data: modelIds.map(toOpenAiModel)
    });
  });

  app.get<{ Params: { model: string } }>("/v1/models/:model", async (request, reply) => {
    const modelIds = await deps.getMergedModelIds();
    const model = modelIds.find((entry) => entry === request.params.model);
    if (!model) {
      sendOpenAiError(reply, 404, `Model not found: ${request.params.model}`, "invalid_request_error", "model_not_found");
      return;
    }

    reply.send(toOpenAiModel(model));
  });
}
