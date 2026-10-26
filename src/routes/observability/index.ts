import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import { getToolSeedForModel, loadMcpSeeds } from "../../lib/tool-mcp-seed.js";
import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";

const API_V1_OBSERVABILITY_ROUTE_PREFIX = "/api/v1";

export interface ObservabilityRouteOptions extends PrefixedRouteOptions {
  readonly includeRequestLogs?: boolean;
  readonly includeDashboardOverview?: boolean;
  readonly includeProviderModelAnalytics?: boolean;
  readonly includeTools?: boolean;
  readonly includeMcpServers?: boolean;
}

/**
 * Request logs, dashboard overview, provider/model analytics, tool seeds and MCP
 * server seeds. The routes, scoping decisions and usage folds are CLJS
 * (`proxx.runtime.routes.observability`, `proxx.http.observability`,
 * `proxx.analytics.usage`); the host's stores and seed loaders are handed in.
 * Without `options` the legacy `/api/ui` prefix is used.
 */
export async function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: ObservabilityRouteOptions,
): Promise<void> {
  kernels.registerObservabilityRoutes(
    app,
    {
      requestLogStore: deps.requestLogStore,
      keyPool: deps.keyPool,
      credentialStore: deps.credentialStore,
      sqlRequestUsageStore: deps.sqlRequestUsageStore,
      getToolSeedForModel,
      loadMcpSeeds,
    },
    options,
  );
}

export async function registerCanonicalObservabilityRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<void> {
  await registerObservabilityRoutes(app, deps, { prefix: API_V1_OBSERVABILITY_ROUTE_PREFIX });
}
