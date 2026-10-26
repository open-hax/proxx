import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import type { UiRouteDependencies } from "../types.js";

/**
 * Host dashboard routes (`/api/v1/hosts/self`, `/api/v1/hosts/overview`). The
 * routes and their decisions are CLJS (`proxx.runtime.routes.hosts`,
 * `proxx.http.hosts`); the environment is handed in.
 */
export async function registerHostRoutes(
  app: FastifyInstance,
  _deps: UiRouteDependencies,
): Promise<void> {
  kernels.registerHostRoutes(app, process.env, "/api/v1");
}
