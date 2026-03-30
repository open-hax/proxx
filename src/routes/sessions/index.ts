import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../types.js";

export { registerSessionUiRoutes } from "./ui.js";
export { createSessionUiRouteContext } from "./context.js";
export type { SessionUiRouteContext } from "./context.js";
import { createSessionUiRouteContext } from "./context.js";
import { API_V1_SESSION_ROUTE_PREFIX } from "./prefix.js";
import { registerSessionUiRoutes } from "./ui.js";

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies
): Promise<void> {
  const context = createSessionUiRouteContext({
    ollamaBaseUrl: deps.config.ollamaBaseUrl,
    warn: (error) => {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to warm semantic session index from stored sessions",
      );
    },
  });

  await registerSessionUiRoutes(app, deps, context, { prefix: API_V1_SESSION_ROUTE_PREFIX });
}
