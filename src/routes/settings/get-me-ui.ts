import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { getResolvedAuth, toVisibleTenants } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerGetMeUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.get(resolveSettingsRoutePath("/me", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const tenants = deps.sqlCredentialStore
      ? toVisibleTenants(
        auth,
        auth.kind === "legacy_admin"
          ? await deps.sqlCredentialStore.listTenants()
          : [],
      )
      : [];

    reply.send({
      auth,
      activeTenantId: auth.tenantId ?? null,
      memberships: auth.memberships ?? [],
      tenants,
    });
  });
}
