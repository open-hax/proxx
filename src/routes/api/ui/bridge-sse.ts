import type { FastifyInstance } from "fastify";

import type { FederationBridgeRelay } from "../../../lib/federation/bridge-relay.js";
import { kernels } from "../../../lib/cljs-kernels.js";
import { DEFAULT_TENANT_ID } from "../../../lib/tenant-api-key.js";
import type { UiRouteDependencies } from "../../types.js";

/**
 * The bridge's SSE transport (`/api/ui/federation/bridge/sse`, `.../sse/hello`,
 * `.../sse/message`). Routes, session-binding rules and framing are CLJS
 * (`proxx.runtime.routes.streams`, `proxx.http.streams`).
 */
export async function registerBridgeSseRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  bridgeRelay: FederationBridgeRelay,
): Promise<void> {
  kernels.registerBridgeSseRoutes(
    app,
    {
      proxyAuthToken: deps.config.proxyAuthToken,
      sqlCredentialStore: deps.sqlCredentialStore,
      authPersistence: deps.authPersistence,
      proxyTokenPepper: deps.config.proxyTokenPepper,
      defaultTenantId: DEFAULT_TENANT_ID,
    },
    bridgeRelay,
  );
}
