import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../routes/types.js";
import type { CredentialStoreLike } from "./credential-store.js";
import {
  collectLocalHostDashboardSnapshot,
  fetchRemoteHostDashboardSnapshot,
  inferSelfHostDashboardTargetId,
  loadHostDashboardTargetsFromEnv,
  resolveHostDashboardTargetToken,
} from "./host-dashboard.js";
import { resolveRequestAuth, type ResolvedRequestAuth } from "./request-auth.js";
import type { KeyPool, KeyPoolAccountStatus } from "./key-pool.js";
import { RequestLogStore, type RequestLogEntry } from "./request-log-store.js";
import { registerCredentialUiRoutes } from "../routes/credentials/index.js";
import { registerFederationUiRoutes } from "../routes/federation/index.js";
import type { FederationAccountsResponse, FederationCredentialExport } from "../routes/federation/account-knowledge.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  projectedAccountAllowsCredentialImport,
} from "../routes/federation/remote.js";
import { createSessionUiRouteContext, registerSessionUiRoutes } from "../routes/sessions/index.js";
import { registerSettingsUiRoutes } from "../routes/settings/index.js";
import {
  authCanManageFederation,
  authCanViewTenant,
  getResolvedAuth,
  readCookieValue,
} from "../routes/shared/ui-auth.js";
import { getToolSeedForModel, loadMcpSeeds } from "./tool-mcp-seed.js";
import type { SqlRequestUsageStore } from "./db/sql-request-usage-store.js";
import { normalizeTenantId } from "./tenant-api-key.js";
import { createFederationBridgeRelay, type FederationBridgeRelay } from "./federation/bridge-relay.js";
import { RequestLogWsHub, type RequestLogWsSubscription } from "./observability/request-log-ws-hub.js";
import { registerUsageAnalyticsRoutes } from "../routes/api/ui/analytics/usage.js";
import { registerHostDashboardRoutes } from "../routes/api/ui/hosts/index.js";
import { registerEventRoutes } from "../routes/api/ui/events/index.js";
import { registerMcpSeedRoutes } from "../routes/api/ui/mcp/index.js";
import { registerStaticAssetRoutes } from "../routes/api/ui/assets.js";
import { registerWebSocketRoutes } from "../routes/api/ui/ws.js";



function parseRequestLogRouteKind(value: string | undefined): RequestLogWsSubscription["routeKind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "federated" || normalized === "bridge" || normalized === "routed" || normalized === "any") {
    return normalized;
  }
  return undefined;
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate.
    }
  }
  return undefined;
}

export function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }
  return fallback;
}

export async function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<FederationBridgeRelay> {
  app.addHook("onRequest", async (request, reply) => {
    const rawPath = request.raw.url?.split("?")[0] ?? request.url.split("?")[0];
    if (rawPath.startsWith("/api/ui/")) {
      reply.header("Deprecation", "true");
      reply.header("Link", `</api/v1${rawPath.slice("/api/ui".length)}>; rel="successor-version"`);
    }
  });

  const sessionContext = createSessionUiRouteContext({
    ollamaBaseUrl: deps.config.ollamaBaseUrl,
    warn: (error) => {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to warm semantic session index from stored sessions",
      );
    },
  });

  const { bridgeRelay } = await registerWebSocketRoutes(app, deps);

  // Register sub-module routes
  await registerSettingsUiRoutes(app, deps);
  await registerSessionUiRoutes(app, deps, sessionContext);
  await registerFederationUiRoutes(app, deps, { bridgeRelay, federationRequestTimeoutMs: toSafeLimit(process.env.FEDERATION_REQUEST_TIMEOUT_MS, 5000, 60_000) });
  await registerUsageAnalyticsRoutes(app, deps);
  await registerHostDashboardRoutes(app, deps);
  await registerCredentialUiRoutes(app, deps);
  await registerMcpSeedRoutes(app, deps);
  await registerEventRoutes(app, deps);
  await registerStaticAssetRoutes(app);

  return bridgeRelay;
}
