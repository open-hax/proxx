import type { FastifyInstance } from "fastify";
import type { FederationBridgeRelay } from "../../lib/federation/bridge-relay.js";

import { kernels } from "../../lib/cljs-kernels.js";
import { shouldWarmImportProjectedAccount } from "../../lib/db/sql-federation-store.js";
import type { UiRouteDependencies } from "../types.js";
import { LEGACY_FEDERATION_ROUTE_PREFIX, type FederationRouteOptions } from "./prefix.js";

export interface FederationUiRouteContext {
  readonly bridgeRelay?: FederationBridgeRelay;
  readonly federationRequestTimeoutMs?: number;
}

/**
 * Federation control-plane routes (peers, bridge sessions and lease import,
 * account knowledge/export/import, usage exchange, sync pull, projected-account
 * routing, tenant provider policies). The routes and every decision are CLJS
 * (`proxx.runtime.routes.federation`, `proxx.http.federation`); this hands the
 * host's stores and relay to them.
 */
export async function registerFederationUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  context: FederationUiRouteContext = {},
  options?: FederationRouteOptions,
): Promise<void> {
  kernels.registerFederationRoutes(
    app,
    {
      env: process.env,
      openaiProviderId: deps.config.openaiProviderId,
      sqlFederationStore: deps.sqlFederationStore,
      sqlTenantProviderPolicyStore: deps.sqlTenantProviderPolicyStore,
      sqlRequestUsageStore: deps.sqlRequestUsageStore,
      sqlCredentialStore: deps.sqlCredentialStore,
      credentialStore: deps.credentialStore,
      keyPool: deps.keyPool,
      requestLogStore: deps.requestLogStore,
      bridgeRelay: context.bridgeRelay,
      federationRequestTimeoutMs: context.federationRequestTimeoutMs,
      refreshOpenAiOauthAccounts: deps.refreshOpenAiOauthAccounts,
      shouldWarmImportProjectedAccount,
      log: app.log,
    },
    options?.prefix ?? LEGACY_FEDERATION_ROUTE_PREFIX,
  );
}
