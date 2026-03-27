import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";

export { registerFederationUiRoutes } from "./ui.js";
export type { FederationUiRouteContext } from "./ui.js";

export async function registerFederationRoutes(
  _app: FastifyInstance,
  _deps: UiRouteDependencies
): Promise<void> {
  // Routes will be migrated from lib/ui-routes.ts
  // This is a placeholder to establish the MVC structure
}
