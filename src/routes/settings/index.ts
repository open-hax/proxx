import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";

export { registerSettingsUiRoutes } from "./ui.js";
import { API_V1_SETTINGS_ROUTE_PREFIX } from "./prefix.js";
import { registerSettingsUiRoutes } from "./ui.js";

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies
): Promise<void> {
  await registerSettingsUiRoutes(app, deps, { prefix: API_V1_SETTINGS_ROUTE_PREFIX });
}
