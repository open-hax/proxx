import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "./types.js";

export interface RouteRegistrar {
  (app: FastifyInstance, deps: UiRouteDependencies): Promise<void>;
}

export async function registerAllRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<void> {
  const routes: RouteRegistrar[] = [
    (await import("./federation/index.js")).registerFederationRoutes,
    (await import("./settings/index.js")).registerSettingsRoutes,
    (await import("./sessions/index.js")).registerSessionRoutes,
    (await import("./credentials/index.js")).registerCredentialsRoutes,
    (await import("./hosts/index.js")).registerHostRoutes,
    (await import("./events/index.js")).registerEventRoutes,
    (await import("./mcp/index.js")).registerMcpRoutes,
    (await import("./ui/index.js")).registerUiRoutes,
  ];

  for (const register of routes) {
    await register(app, deps);
  }
}
