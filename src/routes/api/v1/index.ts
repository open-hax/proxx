import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../types.js";
import type { FederationBridgeRelay } from "../../../lib/federation/bridge-relay.js";

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
    (await import("../../mcp/index.js")).registerMcpRoutes,
    (await import("../../observability/index.js")).registerCanonicalObservabilityRoutes,
  ] as const;

  for (const registerRoute of registerRoutes) {
    await registerRoute(app, deps);
  }

  app.get("/api/v1", async () => ({
    version: "1.0.0",
    migration: {
      legacyPrefix: "/api/ui",
      targetPrefix: "/api/v1",
      strategy: "planned_to_implemented",
      deprecationRule: "legacy routes are deprecated only after the corresponding /api/v1 endpoint is implemented",
    },
    summary: {
      planned: countEndpointsWithStatus("planned"),
      implemented: countEndpointsWithStatus("implemented"),
    },
    endpoints: API_V1_ENDPOINTS,
    documentation: {
      path: "/api/v1/openapi.json",
      status: "implemented",
    },
  }));
}
