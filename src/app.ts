/**
 * Host of the Proxx application. The application itself is CLJS
 * (`proxx.app.main`, `proxx.app.entry`); the stores, pools and managers it
 * composes are still classes in this repository, so this module hands their
 * factories (and the route bundles that need host functions) to it as `host`.
 *
 * `createApp(config)` is the CLJS application over this host; the Node entry
 * (`node dist/cljs/main.js`) imports this module and uses `host` and `prepare`.
 */
import type { FastifyInstance } from "fastify";

import "./lib/fastify-types.js";

import type { ProxyConfig } from "./lib/config.js";
import { assertCljsRuntimeReady, loadCljsRuntime, setActiveCljsRuntime } from "./lib/cljs-runtime.js";
import { kernels } from "./lib/cljs-kernels.js";
import { PROXY_AUTH_COOKIE_NAME } from "./lib/request-utils.js";
import { buildOllamaCatalogRoutes, getDeclaredProviderRoutes } from "./lib/provider-routing.js";
import { isOpenAiHttpError } from "./lib/provider-utils.js";
import { RequestLogStore } from "./lib/request-log-store.js";
import { SqlPromptAffinityStore } from "./lib/db/sql-prompt-affinity-store.js";
import { ProviderRoutePheromoneStore } from "./lib/provider-route-pheromone-store.js";
import { RequestLogSseHub } from "./lib/observability/request-log-sse-hub.js";
import { registerWebSocketRoutes } from "./routes/api/ui/ws.js";
import { registerBridgeSseRoutes } from "./routes/api/ui/bridge-sse.js";
import { registerRequestLogSseRoutes } from "./routes/api/ui/request-log-sse.js";
import { registerApiV1Routes } from "./routes/api/v1/index.js";
import { registerObservabilityRoutes } from "./routes/observability/index.js";
import { modelIdsToNativeTags } from "./lib/ollama-native.js";
import { createSqlConnection, closeConnection, type Sql } from "./lib/db/index.js";
import { SqlCredentialStore } from "./lib/db/sql-credential-store.js";
import { AccountHealthStore } from "./lib/db/account-health-store.js";
import { EventStore } from "./lib/db/event-store.js";
import { createDefaultLabelers } from "./lib/db/event-labelers.js";
import { SqlRequestUsageStore } from "./lib/db/sql-request-usage-store.js";
import { SqlFederationStore } from "./lib/db/sql-federation-store.js";
import { SqlTenantProviderPolicyStore } from "./lib/db/sql-tenant-provider-policy-store.js";
import { SqlAuthPersistence } from "./lib/auth/sql-persistence.js";
import { DEFAULT_TENANT_ID } from "./lib/tenant-api-key.js";
import { createEnvFederationBridgeAgent } from "./lib/federation/bridge-agent-autostart.js";
import { executeFederatedRequestRouting } from "./lib/federation/federated-routing.js";
import { handleBridgeRequest, injectNativeBridge } from "./lib/federation/bridge-routing.js";
import { v1RouteCollaborators } from "./routes/chat.js";
import { embeddingsRouteCollaborators } from "./routes/embeddings.js";
import { mediaRouteCollaborators } from "./routes/media-generations.js";

type Args<T extends abstract new (...args: never[]) => unknown> = ConstructorParameters<T>;

export const host = {
  isOpenAiHttpError,
  defaultTenantId: DEFAULT_TENANT_ID,
  proxyAuthCookieName: PROXY_AUTH_COOKIE_NAME,
  createSqlConnection,
  closeConnection,
  createDefaultLabelers,
  /** SQL-backed stores by their id in the application wiring plan (proxx.app.wiring). */
  sql: {
    credential: (connection: Sql) => new SqlCredentialStore(connection, { defaultTenantId: DEFAULT_TENANT_ID }),
    accountHealth: (connection: Sql) => new AccountHealthStore(connection),
    event: (connection: Sql) => new EventStore(connection),
    requestUsage: (connection: Sql) => new SqlRequestUsageStore(connection),
    federation: (connection: Sql) => new SqlFederationStore(connection),
    tenantProviderPolicy: (connection: Sql) => new SqlTenantProviderPolicyStore(connection),
    authPersistence: (connection: Sql) => new SqlAuthPersistence(connection),
  },
  requestLogStore: (...args: Args<typeof RequestLogStore>) => new RequestLogStore(...args),
  requestLogSseHub: (...args: Args<typeof RequestLogSseHub>) => new RequestLogSseHub(...args),
  promptAffinityStore: (...args: Args<typeof SqlPromptAffinityStore>) => new SqlPromptAffinityStore(...args),
  pheromoneStore: (...args: Args<typeof ProviderRoutePheromoneStore>) => new ProviderRoutePheromoneStore(...args),
  createEnvFederationBridgeAgent,
  handleBridgeRequest,
  injectNativeBridge,
  executeFederatedRequestRouting,
  getDeclaredProviderRoutes,
  buildOllamaCatalogRoutes,
  modelIdsToNativeTags,
  routes: {
    v1Collaborators: v1RouteCollaborators,
    embeddingsCollaborators: embeddingsRouteCollaborators,
    mediaCollaborators: mediaRouteCollaborators,
    registerWebSocketRoutes,
    registerBridgeSseRoutes,
    registerRequestLogSseRoutes,
    registerApiV1Routes,
    registerObservabilityRoutes,
  },
};

/** Make the CLJS runtime the active one for host modules that consult it, after checking it is sound. */
export async function prepare(): Promise<void> {
  const loaded = await loadCljsRuntime({ required: true });
  if (!loaded.loaded) {
    throw new Error(`CLJS runtime is required: ${loaded.reason}`);
  }
  await assertCljsRuntimeReady(loaded.runtime);
  setActiveCljsRuntime(loaded.runtime);
}

/** The application: `proxx.app.main/create-app-js` over this host. */
export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  return kernels.createApp(config, host);
}
