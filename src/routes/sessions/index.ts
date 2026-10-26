import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import type { UiRouteDependencies } from "../types.js";
import { createSessionUiRouteContext } from "./context.js";

export { createSessionUiRouteContext } from "./context.js";
export type { SessionUiRouteContext } from "./context.js";

/**
 * Session routes (`/api/v1/sessions*`). The routes, message validation and the
 * search decision are CLJS (`proxx.runtime.routes.sessions`, `proxx.http.sessions`).
 */
export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies
): Promise<void> {
  const context = createSessionUiRouteContext({ ollamaBaseUrl: deps.config.ollamaBaseUrl });

  kernels.registerSessionRoutes(
    app,
    {
      sessionStore: context.sessionStore,
      sessionIndex: context.sessionIndex,
      warn: (error: unknown) => {
        app.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "failed to warm semantic session index from stored sessions",
        );
      },
    },
    "/api/v1",
  );
}
