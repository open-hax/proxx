import type { FastifyInstance } from "fastify";

import { kernels } from "../lib/cljs-kernels.js";
import type { AppDeps } from "../lib/app-deps.js";
import { v1RouteCollaborators } from "./chat.js";

/** POST /v1/images/generations: served from CLJS (proxx.runtime.routes.v1). */
export function registerImagesRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerImagesRoutes(app, deps, v1RouteCollaborators());
}
