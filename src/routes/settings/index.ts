import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";
import { registerSettingsUiRoutes } from "./ui.js";

export { registerSettingsUiRoutes } from "./ui.js";

const API_V1_SETTINGS_ROUTE_PREFIX = "/api/v1";

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies
): Promise<void> {
  await registerSettingsUiRoutes(app, deps, { prefix: API_V1_SETTINGS_ROUTE_PREFIX });
}
