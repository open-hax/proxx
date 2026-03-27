import type { FastifyInstance } from "fastify";

import { DEFAULT_TENANT_ID } from "../../lib/tenant-api-key.js";
import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { getResolvedAuth } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerGetSettingsUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.get(resolveSettingsRoutePath("/settings", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const settings = await deps.proxySettingsStore.getForTenant(auth.tenantId ?? DEFAULT_TENANT_ID);
    reply.send(settings);
  });
}
