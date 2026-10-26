import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { kernels } from "../lib/cljs-kernels.js";

/**
 * POST /api/tools/websearch. The route (request validation, the injected
 * /v1/responses attempts, the Exa fallback and the failure body) lives in CLJS:
 * proxx.http.websearch decides, proxx.runtime.routes.websearch performs the
 * effects.
 */
export function registerWebsearchRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerWebsearchRoutes(app, deps);
}
