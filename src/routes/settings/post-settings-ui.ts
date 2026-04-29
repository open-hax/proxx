import type { FastifyInstance } from "fastify";

import { DEFAULT_TENANT_ID } from "../../lib/tenant-api-key.js";
import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import {
  getResolvedAuth,
  parseBoolean,
  parseOptionalModelIds,
  parseOptionalProviderIds,
  parseOptionalRequestsPerMinute,
} from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerPostSettingsUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.post<{
    Body: {
      readonly fastMode?: unknown;
      readonly requestsPerMinute?: unknown;
      readonly allowedModels?: unknown;
      readonly allowedProviderIds?: unknown;
      readonly disabledProviderIds?: unknown;
    };
  }>(resolveSettingsRoutePath("/settings", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (auth.kind === "tenant_api_key") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    if (auth.kind === "ui_session" && auth.role !== "owner" && auth.role !== "admin") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const requestsPerMinute = parseOptionalRequestsPerMinute(request.body?.requestsPerMinute);
    if (request.body?.requestsPerMinute !== undefined && requestsPerMinute === undefined) {
      reply.code(400).send({ error: "invalid_requests_per_minute" });
      return;
    }

    const allowedProviderIds = parseOptionalProviderIds(request.body?.allowedProviderIds);
    if (request.body?.allowedProviderIds !== undefined && allowedProviderIds === undefined) {
      reply.code(400).send({ error: "invalid_allowed_provider_ids" });
      return;
    }

    const allowedModels = parseOptionalModelIds(request.body?.allowedModels);
    if (request.body?.allowedModels !== undefined && allowedModels === undefined) {
      reply.code(400).send({ error: "invalid_allowed_models" });
      return;
    }

    const disabledProviderIds = parseOptionalProviderIds(request.body?.disabledProviderIds);
    if (request.body?.disabledProviderIds !== undefined && disabledProviderIds === undefined) {
      reply.code(400).send({ error: "invalid_disabled_provider_ids" });
      return;
    }

    const tenantId = auth.tenantId ?? DEFAULT_TENANT_ID;
    const nextSettings = await deps.proxySettingsStore.setForTenant({
      fastMode: request.body?.fastMode === undefined ? undefined : parseBoolean(request.body?.fastMode),
      requestsPerMinute,
      allowedModels,
      allowedProviderIds,
      disabledProviderIds,
    }, tenantId);

    app.log.info({
      fastMode: nextSettings.fastMode,
      requestsPerMinute: nextSettings.requestsPerMinute,
      allowedModels: nextSettings.allowedModels,
      allowedProviderIds: nextSettings.allowedProviderIds,
      disabledProviderIds: nextSettings.disabledProviderIds,
      tenantId,
    }, "updated proxy UI settings");
    reply.send(nextSettings);
  });
}
