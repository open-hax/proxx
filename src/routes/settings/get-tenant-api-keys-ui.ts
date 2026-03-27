import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { authCanManageTenantKeys, getResolvedAuth } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerGetTenantApiKeysUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.get<{ Params: { readonly tenantId: string } }>(resolveSettingsRoutePath("/tenants/:tenantId/api-keys", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
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

    const keys = await deps.sqlCredentialStore.listTenantApiKeys(request.params.tenantId);
    reply.send({ tenantId: request.params.tenantId, keys });
  });
}
