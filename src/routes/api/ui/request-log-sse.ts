import type { FastifyInstance } from "fastify";

import { kernels } from "../../../lib/cljs-kernels.js";
import type { RequestLogSseHub } from "../../../lib/observability/request-log-sse-hub.js";
import { DEFAULT_TENANT_ID } from "../../../lib/tenant-api-key.js";
import type { UiRouteDependencies } from "../../types.js";

/**
 * GET /api/v1/federation/observability/sse. The route, its authorization and the
 * stream's head/keepalive are CLJS (`proxx.runtime.routes.streams`,
 * `proxx.http.streams`); the hub owns the client set.
 */
export async function registerRequestLogSseRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  requestLogSseHub: RequestLogSseHub,
): Promise<void> {
  kernels.registerRequestLogSseRoutes(
    app,
    {
      proxyAuthToken: deps.config.proxyAuthToken,
      sqlCredentialStore: deps.sqlCredentialStore,
      authPersistence: deps.authPersistence,
      proxyTokenPepper: deps.config.proxyTokenPepper,
      defaultTenantId: DEFAULT_TENANT_ID,
    },
    requestLogSseHub,
  );
}
