import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { authCanManageTenantKeys, getResolvedAuth } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerPostTenantApiKeysUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.post<{
    Params: { readonly tenantId: string };
    Body: { readonly label?: string; readonly scopes?: readonly string[] };
  }>(resolveSettingsRoutePath("/tenants/:tenantId/api-keys", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    if (!authCanManageTenantKeys(auth, request.params.tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    if (label.length === 0) {
      reply.code(400).send({ error: "label_required" });
      return;
    }

    const scopes = Array.isArray(request.body?.scopes)
      ? request.body.scopes.filter((scope): scope is string => typeof scope === "string")
      : ["proxy:use"];

    const created = await deps.sqlCredentialStore.createTenantApiKey(
      request.params.tenantId,
      label,
      scopes,
      deps.config.proxyTokenPepper,
    );

    reply.code(201).send(created);
  });
}
