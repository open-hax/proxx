import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { getResolvedAuth, toVisibleTenants } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerGetTenantsUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.get(resolveSettingsRoutePath("/tenants", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(501).send({ error: "tenant_store_not_supported" });
      return;
    }

    const visibleTenants = toVisibleTenants(
      auth,
      auth.kind === "legacy_admin"
        ? await deps.sqlCredentialStore.listTenants()
        : [],
    );

    reply.send({ tenants: visibleTenants });
  });
}
