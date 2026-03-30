import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";

export { registerFederationUiRoutes } from "./ui.js";
export type { FederationUiRouteContext } from "./ui.js";
import { API_V1_FEDERATION_ROUTE_PREFIX } from "./prefix.js";
import type { FederationBridgeRelay } from "../../lib/federation/bridge-relay.js";
import { registerFederationUiRoutes } from "./ui.js";

export interface FederationRouteDependencies extends UiRouteDependencies {
  readonly bridgeRelay?: FederationBridgeRelay;
}

export async function registerFederationRoutes(
  app: FastifyInstance,
  deps: FederationRouteDependencies
): Promise<void> {
  await registerFederationUiRoutes(app, deps, {
    bridgeRelay: deps.bridgeRelay,
  }, {
    prefix: API_V1_FEDERATION_ROUTE_PREFIX,
  });
}
