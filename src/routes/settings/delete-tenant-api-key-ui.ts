import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { authCanManageTenantKeys, getResolvedAuth } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerDeleteTenantApiKeyUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.delete<{ Params: { readonly tenantId: string; readonly keyId: string } }>(resolveSettingsRoutePath("/tenants/:tenantId/api-keys/:keyId", options), async (request, reply) => {
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

    const revoked = await deps.sqlCredentialStore.revokeTenantApiKey(request.params.tenantId, request.params.keyId);
    if (!revoked) {
      reply.code(404).send({ error: "tenant_api_key_not_found" });
      return;
    }

    reply.send({ ok: true, tenantId: request.params.tenantId, keyId: request.params.keyId });
  });
}
