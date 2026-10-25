import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import { joinRoutePath, type PrefixedRouteOptions, type UiRouteDependencies } from "../types.js";

const LEGACY_SETTINGS_ROUTE_PREFIX = "/api/ui";

/**
 * Settings and tenant routes (`/settings`, `/me`, `/tenants`, tenant API keys,
 * tenant selection). The routes and their decisions are CLJS
 * (`proxx.runtime.routes.settings`, `proxx.http.settings`); this hands the
 * host's stores to them.
 */
export async function registerSettingsUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  kernels.registerSettingsRoutes(
    app,
    {
      proxySettingsStore: deps.proxySettingsStore,
      sqlCredentialStore: deps.sqlCredentialStore,
      authPersistence: deps.authPersistence,
      proxyTokenPepper: deps.config.proxyTokenPepper,
      log: app.log,
    },
    joinRoutePath(options?.prefix ?? LEGACY_SETTINGS_ROUTE_PREFIX, ""),
  );
}
