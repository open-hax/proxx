import type { FastifyInstance } from "fastify";

import type { PrefixedRouteOptions, UiRouteDependencies } from "../types.js";
import { registerDeleteTenantApiKeyUiRoute } from "./delete-tenant-api-key-ui.js";
import { registerGetMeUiRoute } from "./get-me-ui.js";
import { registerGetSettingsUiRoute } from "./get-settings-ui.js";
import { registerGetTenantApiKeysUiRoute } from "./get-tenant-api-keys-ui.js";
import { registerGetTenantsUiRoute } from "./get-tenants-ui.js";
import { registerPostSettingsUiRoute } from "./post-settings-ui.js";
import { registerPostTenantApiKeysUiRoute } from "./post-tenant-api-keys-ui.js";
import { registerPostTenantSelectUiRoute } from "./post-tenant-select-ui.js";

export async function registerSettingsUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: PrefixedRouteOptions,
): Promise<void> {
  await registerGetSettingsUiRoute(app, deps, options);
  await registerPostSettingsUiRoute(app, deps, options);
  await registerGetMeUiRoute(app, deps, options);
  await registerGetTenantsUiRoute(app, deps, options);
  await registerPostTenantSelectUiRoute(app, deps, options);
  await registerGetTenantApiKeysUiRoute(app, deps, options);
  await registerPostTenantApiKeysUiRoute(app, deps, options);
  await registerDeleteTenantApiKeyUiRoute(app, deps, options);
}
