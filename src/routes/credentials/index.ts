import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";

export { registerCredentialUiRoutes } from "./ui.js";
import { API_V1_CREDENTIAL_ROUTE_PREFIX } from "./prefix.js";
import { registerCredentialUiRoutes } from "./ui.js";

export async function registerCredentialsRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies
): Promise<void> {
  await registerCredentialUiRoutes(app, deps, {
    prefix: API_V1_CREDENTIAL_ROUTE_PREFIX,
    registerSharedAuthCallbacks: false,
  });
}
