import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../../types.js";
import { kernels } from "../../../lib/cljs-kernels.js";
import { createFederationBridgeRelay, type FederationBridgeRelay } from "../../../lib/federation/bridge-relay.js";
import { RequestLogWsHub } from "../../../lib/observability/request-log-ws-hub.js";
import { DEFAULT_TENANT_ID } from "../../../lib/tenant-api-key.js";

/**
 * WebSocket upgrades for the bridge relay and the request-log hub. The `upgrade`
 * listener, origin check and authorization are CLJS (`proxx.runtime.routes.ws`,
 * `proxx.http.streams`); the relay and hub are created here and returned.
 */
export async function registerWebSocketRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<{ bridgeRelay: FederationBridgeRelay; requestLogWsHub: RequestLogWsHub }> {
  return kernels.registerWebSocketRoutes(app, {
    proxyAuthToken: deps.config.proxyAuthToken,
    sqlCredentialStore: deps.sqlCredentialStore,
    authPersistence: deps.authPersistence,
    proxyTokenPepper: deps.config.proxyTokenPepper,
    defaultTenantId: DEFAULT_TENANT_ID,
    requestLogStore: deps.requestLogStore,
    createBridgeRelay: createFederationBridgeRelay,
    createRequestLogWsHub: (store: UiRouteDependencies["requestLogStore"]) => new RequestLogWsHub(store),
  }) as { bridgeRelay: FederationBridgeRelay; requestLogWsHub: RequestLogWsHub };
}
