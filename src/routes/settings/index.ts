import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../lib/ui-routes.js";

export async function registerSettingsRoutes(
  _app: FastifyInstance,
  _deps: UiRouteDependencies
): Promise<void> {
  // Routes will be migrated from lib/ui-routes.ts
}
