import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { kernels } from "../lib/cljs-kernels.js";

/**
 * GET /health. The route and its report are CLJS (`proxx.runtime.routes`,
 * `proxx.http.health`); this wires the host's collaborators in.
 */
export function registerHealthRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerHealthRoutes(app, {
    keyPool: deps.keyPool,
    upstreamProviderId: deps.config.upstreamProviderId,
    proxyAuthTokenConfigured: Boolean(deps.config.proxyAuthToken),
  });
}
