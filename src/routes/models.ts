import type { FastifyInstance } from "fastify";

import { getActiveCljsRuntime } from "../lib/cljs-runtime.js";
import { toOpenAiModel } from "../lib/models.js";
import { sendOpenAiError } from "../lib/provider-utils.js";
import type { AppDeps } from "../lib/app-deps.js";

function policyAllowsModel(deps: AppDeps, tenantSettings: unknown, modelId: string): boolean {
  const result = getActiveCljsRuntime()?.previewPolicyDecision(deps.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", {
    modelId,
    requestKind: "chat",
    tenantSettings,
    providerIds: [],
  });
  const decision = result?.status === "ok" && typeof result.decision === "object" && result.decision !== null
    ? result.decision as { readonly status?: unknown; readonly reason?: unknown }
    : undefined;
  return !(decision?.status === "denied" && decision.reason === "tenant-model-not-allowed");
}

export function registerModelsRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.get("/v1/models", async (request, reply) => {
    const tenantId = (request.openHaxAuth?.tenantId) ?? "default";
    const tenantSettings = await deps.proxySettingsStore.getForTenant(tenantId);
    const modelIds = (await deps.getMergedModelIds()).filter((modelId) => policyAllowsModel(deps, tenantSettings, modelId));
    reply.send({
      object: "list",
      data: modelIds.map(toOpenAiModel)
    });
  });

  app.get<{ Params: { model: string } }>("/v1/models/:model", async (request, reply) => {
    const tenantId = (request.openHaxAuth?.tenantId) ?? "default";
    const tenantSettings = await deps.proxySettingsStore.getForTenant(tenantId);
    const modelIds = (await deps.getMergedModelIds()).filter((modelId) => policyAllowsModel(deps, tenantSettings, modelId));
    const model = modelIds.find((entry) => entry === request.params.model);
    if (!model) {
      sendOpenAiError(reply, 404, `Model not found: ${request.params.model}`, "invalid_request_error", "model_not_found");
      return;
    }

    reply.send(toOpenAiModel(model));
  });
}
