import type { FastifyInstance } from "fastify";

import { normalizeTenantId } from "../../lib/tenant-api-key.js";
import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { authCanViewTenant, getResolvedAuth, readCookieValue } from "../shared/ui-auth.js";
import { resolveSettingsRoutePath } from "./prefix.js";

export async function registerPostTenantSelectUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  app.post<{ Params: { readonly tenantId: string } }>(resolveSettingsRoutePath("/tenants/:tenantId/select", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    if (!deps.authPersistence) {
      reply.code(501).send({ error: "auth_persistence_not_supported" });
      return;
    }

    if (auth.kind !== "ui_session") {
      reply.code(400).send({ error: "ui_session_required" });
      return;
    }

    const tenantId = normalizeTenantId(request.params.tenantId);
    if (!authCanViewTenant(auth, tenantId)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const accessToken = readCookieValue(request.headers.cookie, "proxy_auth");
    if (!accessToken) {
      reply.code(401).send({ error: "session_cookie_missing" });
      return;
    }

    const storedAccessToken = await deps.authPersistence.getAccessToken(accessToken);
    if (!storedAccessToken || storedAccessToken.subject !== auth.subject) {
      reply.code(401).send({ error: "invalid_session" });
      return;
    }

    const nextAccessExtra = {
      ...(storedAccessToken.extra ?? {}),
      activeTenantId: tenantId,
    };
    await deps.authPersistence.updateAccessTokenExtra(accessToken, nextAccessExtra);

    const refreshToken = readCookieValue(request.headers.cookie, "proxy_refresh");
    if (refreshToken) {
      const storedRefreshToken = await deps.authPersistence.getRefreshToken(refreshToken);
      if (storedRefreshToken && storedRefreshToken.subject === auth.subject) {
        const nextRefreshExtra = {
          ...(storedRefreshToken.extra ?? {}),
          activeTenantId: tenantId,
        };
        await deps.authPersistence.updateRefreshTokenExtra(refreshToken, nextRefreshExtra);
      }
    }

    reply.send({ ok: true, activeTenantId: tenantId });
  });
}
