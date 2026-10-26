import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import type { UiRouteDependencies } from "../types.js";

/**
 * Event store routes (`/api/v1/events*`). The routes and the query/tag
 * decisions are CLJS (`proxx.runtime.routes.events`, `proxx.http.events`).
 */
export async function registerEventRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<void> {
  kernels.registerEventRoutes(app, deps.eventStore);
}
