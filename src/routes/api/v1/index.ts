import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../../lib/ui-routes.js";

export interface ApiV1RouteDependencies extends UiRouteDependencies {
  serverUrl?: string;
}

export async function registerApiV1Routes(
  app: FastifyInstance,
  deps: ApiV1RouteDependencies
): Promise<void> {
  await Promise.all([
    (await import("../../federation/index.js")).registerFederationRoutes(app, deps),
    (await import("../../settings/index.js")).registerSettingsRoutes(app, deps),
    (await import("../../sessions/index.js")).registerSessionRoutes(app, deps),
    (await import("../../credentials/index.js")).registerCredentialsRoutes(app, deps),
    (await import("../../hosts/index.js")).registerHostRoutes(app, deps),
    (await import("../../events/index.js")).registerEventRoutes(app, deps),
    (await import("../../mcp/index.js")).registerMcpRoutes(app, deps),
  ]);

  app.get("/api/v1", async () => ({
    version: "1.0.0",
    endpoints: {
      credentials: "/api/v1/credentials",
      federation: "/api/v1/federation",
      sessions: "/api/v1/sessions",
      settings: "/api/v1/settings",
      hosts: "/api/v1/hosts",
      events: "/api/v1/events",
      mcp: "/api/v1/mcp",
    },
    documentation: "/api/v1/openapi.json",
  }));
}
