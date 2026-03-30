import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import { createCredentialRouteContext } from "./context.js";
import { registerCredentialAccountManagementUiRoutes } from "./account-management-ui.js";
import { registerFactoryBrowserOAuthUiRoutes } from "./factory-browser-oauth-ui.js";
import { registerFactoryDeviceOAuthUiRoutes } from "./factory-device-oauth-ui.js";
import { registerGetCredentialsUiRoute } from "./get-credentials-ui.js";
import { registerOpenAiBrowserOAuthUiRoutes } from "./openai-browser-oauth-ui.js";
import { registerOpenAiDeviceOAuthUiRoutes } from "./openai-device-oauth-ui.js";
import { registerOpenAiPromptCacheAuditUiRoute } from "./openai-prompt-cache-audit-ui.js";
import { registerOpenAiProbeUiRoute } from "./openai-probe-ui.js";
import { registerOpenAiQuotaUiRoute } from "./openai-quota-ui.js";
import { registerOpenAiRefreshUiRoute } from "./openai-refresh-ui.js";
import type { CredentialRouteOptions } from "./prefix.js";

export async function registerCredentialUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: CredentialRouteOptions,
): Promise<void> {
  const context = createCredentialRouteContext(deps);

  await registerGetCredentialsUiRoute(app, deps, context, options);
  await registerOpenAiQuotaUiRoute(app, deps, context, options);
  await registerOpenAiPromptCacheAuditUiRoute(app, deps, context, options);
  await registerOpenAiProbeUiRoute(app, deps, context, options);
  await registerOpenAiRefreshUiRoute(app, deps, context, options);
  await registerCredentialAccountManagementUiRoutes(app, deps, context, options);
  await registerOpenAiBrowserOAuthUiRoutes(app, deps, context, options);
  await registerOpenAiDeviceOAuthUiRoutes(app, deps, context, options);
  await registerFactoryDeviceOAuthUiRoutes(app, deps, context, options);
  await registerFactoryBrowserOAuthUiRoutes(app, deps, context, options);
}
