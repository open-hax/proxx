import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../types.js";
import type { FederationBridgeRelay } from "../../../lib/cljs-kernels.js";
import { kernels } from "../../../lib/cljs-kernels.js";

export interface ApiV1RouteDependencies extends UiRouteDependencies {
  serverUrl?: string;
  bridgeRelay?: FederationBridgeRelay;
}

export async function registerApiV1Routes(
  app: FastifyInstance,
  deps: ApiV1RouteDependencies
): Promise<void> {
  const registerRoutes = [
    (await import("../../federation/index.js")).registerFederationRoutes,
    (await import("../../settings/index.js")).registerSettingsRoutes,
    (await import("../../sessions/index.js")).registerSessionRoutes,
    (await import("../../credentials/index.js")).registerCredentialsRoutes,
    (await import("../../hosts/index.js")).registerHostRoutes,
    (await import("../../events/index.js")).registerEventRoutes,
    (await import("../../observability/index.js")).registerCanonicalObservabilityRoutes,
  ] as const;

  for (const registerRoute of registerRoutes) {
    await registerRoute(app, deps);
  }

  kernels.registerApiV1IndexRoute(app);
}
