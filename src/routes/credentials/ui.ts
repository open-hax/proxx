import type { FastifyInstance } from "fastify";

import { kernels } from "../../lib/cljs-kernels.js";
import { fetchOpenAiQuotaSnapshots, probeOpenAiAccount } from "../../lib/openai-quota.js";
import { probeOllamaCloudAccount } from "../../lib/ollama-cloud-probe.js";
import type { UiRouteDependencies } from "../types.js";
import { createCredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

/**
 * Credential routes (listing, probes, account management, OAuth flows). The
 * routes and their decisions are CLJS (`proxx.runtime.routes.credentials`,
 * `proxx.http.credentials`); this hands the host's collaborators to them.
 */
export async function registerCredentialUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: CredentialRouteOptions,
): Promise<void> {
  const context = createCredentialRouteContext(deps);

  kernels.registerCredentialRoutes(
    app,
    {
      config: deps.config,
      keyPool: deps.keyPool,
      credentialStore: context.credentialStore,
      requestLogStore: deps.requestLogStore,
      sqlCredentialStore: deps.sqlCredentialStore,
      sqlRequestUsageStore: deps.sqlRequestUsageStore,
      refreshOpenAiOauthAccounts: deps.refreshOpenAiOauthAccounts,
      openAiOAuthManager: context.openAiOAuthManager,
      factoryOAuthManager: context.factoryOAuthManager,
      pendingOpenAiBrowserReauthTargets: context.pendingOpenAiBrowserReauthTargets,
      fetchOpenAiQuotaSnapshots,
      probeOpenAiAccount,
      probeOllamaCloudAccount,
      log: app.log,
    },
    resolveCredentialRoutePath("", options),
    options?.registerSharedAuthCallbacks !== false,
  );
}
