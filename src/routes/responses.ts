import type { FastifyInstance } from "fastify";

import { kernels } from "../lib/cljs-kernels.js";
import type { AppDeps } from "../lib/app-deps.js";
import { v1RouteCollaborators } from "./chat.js";

/** POST /v1/responses: served from CLJS (proxx.runtime.routes.v1). */
export function registerResponsesRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerResponsesRoutes(app, deps, v1RouteCollaborators());
}
