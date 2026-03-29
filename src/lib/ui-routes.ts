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

async function loadUiIndexHtml(): Promise<string | undefined> {
  const indexPath = await firstExistingPath([
    resolve(process.cwd(), "web/dist/index.html"),
    resolve(process.cwd(), "dist/web/index.html"),
    resolve(process.cwd(), "../web/dist/index.html"),
  ]);

  if (!indexPath) {
    return undefined;
  }

  return readFile(indexPath, "utf8");
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
  const credentialStore = deps.credentialStore;
  const ecosystemsDir = await firstExistingPath([
    resolve(process.cwd(), "../../ecosystems"),
    resolve(process.cwd(), "../ecosystems"),
    resolve(process.cwd(), "ecosystems"),
  ]);
  let mcpSeedCache: { readonly loadedAt: number; readonly seeds: Awaited<ReturnType<typeof loadMcpSeeds>> } | undefined;
  const hostDashboardTargets = loadHostDashboardTargetsFromEnv(process.env);
  const hostDashboardDockerSocketPath = process.env.HOST_DASHBOARD_DOCKER_SOCKET_PATH?.trim() || undefined;
  const hostDashboardRuntimeRoot = process.env.HOST_DASHBOARD_RUNTIME_ROOT?.trim() || undefined;
  const hostDashboardRequestTimeoutMs = toSafeLimit(process.env.HOST_DASHBOARD_REQUEST_TIMEOUT_MS, 5000, 60_000);
  const federationRequestTimeoutMs = toSafeLimit(process.env.FEDERATION_REQUEST_TIMEOUT_MS, 5000, 60_000);
  const bridgeRelay = createFederationBridgeRelay();
  const requestLogWsHub = new RequestLogWsHub(deps.requestLogStore);

  const readHeaderValue = (value: string | readonly string[] | undefined): string | undefined => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
    return undefined;
  };

  const resolveBridgeUpgradeAuth = async (request: IncomingMessage): Promise<ResolvedRequestAuth | undefined> => {
    const authorization = readHeaderValue(request.headers.authorization);
    const cookieHeader = readHeaderValue(request.headers.cookie);
    return resolveRequestAuth({
      allowUnauthenticated: false,
      proxyAuthToken: deps.config.proxyAuthToken,
      authorization,
      cookieToken: readCookieValue(cookieHeader, "open_hax_proxy_auth_token"),
      oauthAccessToken: readCookieValue(cookieHeader, "proxy_auth"),
      resolveTenantApiKey: deps.sqlCredentialStore
        ? async (token) => deps.sqlCredentialStore!.resolveTenantApiKey(token, deps.config.proxyTokenPepper)
        : undefined,
      resolveUiSession: deps.sqlCredentialStore && deps.authPersistence
        ? async (token) => {
            const accessToken = await deps.authPersistence!.getAccessToken(token);
            if (!accessToken) {
              return undefined;
            }

            const activeTenantId = typeof accessToken.extra?.activeTenantId === "string"
              ? accessToken.extra.activeTenantId
              : undefined;
            return deps.sqlCredentialStore!.resolveUiSession(accessToken.subject, activeTenantId);
          }
        : undefined,
    });
  };

  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const isBridgeWs = pathname === "/api/ui/federation/bridge/ws";
    const isRequestLogWs = pathname === "/api/v1/federation/observability/ws";

    if (!isBridgeWs && !isRequestLogWs) {
      return;
    }

    const reject = (status: 401 | 403 | 404, payload: Record<string, unknown>) => {
      if (isBridgeWs) {
        bridgeRelay.rejectUpgrade(socket, status, payload);
      } else {
        requestLogWsHub.rejectUpgrade(socket, status, payload);
      }
    };

    void (async () => {
      // CSRF protection: reject cross-origin WebSocket upgrades
      const origin = request.headers.origin;
      const forwardedHost = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
      const allowedOrigins = new Set([
        `http://localhost`,
        `http://127.0.0.1`,
        `http://${forwardedHost}`,
        `https://${forwardedHost}`,
      ]);
      if (origin && !allowedOrigins.has(origin) && !origin.startsWith("http://localhost:") && !origin.startsWith("http://127.0.0.1:")) {
        reject(403, { error: "invalid_origin" });
        return;
      }

      const auth = await resolveBridgeUpgradeAuth(request);
      if (!auth) {
        reject(401, { error: "unauthorized" });
        return;
      }
      if (!authCanManageFederation(auth)) {
        reject(403, { error: "forbidden" });
        return;
      }

      if (isBridgeWs) {
        bridgeRelay.handleAuthorizedUpgrade(request, socket, head, {
          authKind: auth.kind === "legacy_admin" ? "legacy_admin" : "ui_session",
          subject: auth.subject,
          tenantId: auth.tenantId,
        });
        return;
      }

      const ownerSubject = url.searchParams.get("ownerSubject")?.trim() || undefined;
      const routeKind = url.searchParams.get("routeKind")?.trim() || undefined;
      requestLogWsHub.handleAuthorizedUpgrade(
        request,
        socket,
        head,
        {
          authKind: auth.kind === "legacy_admin" ? "legacy_admin" : "ui_session",
          tenantId: auth.tenantId,
        },
        {
          ownerSubject,
          routeKind: parseRequestLogRouteKind(routeKind),
        },
      );
    })().catch((error) => {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to authorize websocket upgrade",
      );
      reject(401, { error: "unauthorized" });
    });
  };

  app.server.on("upgrade", upgradeHandler);
  app.addHook("onClose", async () => {
    app.server.off("upgrade", upgradeHandler);
    await requestLogWsHub.close();
    await bridgeRelay.close();
  });

  const loadCachedMcpSeeds = async () => {
    const now = Date.now();
    if (mcpSeedCache && now - mcpSeedCache.loadedAt < 30_000) {
      return mcpSeedCache.seeds;
    }

    if (!ecosystemsDir) {
      return [];
    }

    const seeds = await loadMcpSeeds(ecosystemsDir).catch(() => []);
    mcpSeedCache = {
      loadedAt: now,
      seeds,
    };
    return seeds;
  };

  await registerSettingsUiRoutes(app, deps);
  await registerSessionUiRoutes(app, deps, sessionContext);
  await registerFederationUiRoutes(app, deps, {
    bridgeRelay,
    federationRequestTimeoutMs,
  });
  await registerUsageAnalyticsRoutes(app, deps);
  await registerHostDashboardRoutes(app, deps);
  await registerCredentialUiRoutes(app, deps);
  await registerMcpSeedRoutes(app, deps);
  await registerEventRoutes(app, deps);
  await registerStaticAssetRoutes(app);









  await registerCredentialUiRoutes(app, deps);





  const sendUiIndex = async (reply: { type: (value: string) => void; send: (value: unknown) => void }) => {
    const html = await loadUiIndexHtml();
    if (!html) {
      reply.send({ ok: true, name: "open-hax-openai-proxy", version: "0.1.0" });
      return;
    }

    reply.type("text/html; charset=utf-8");
    reply.send(html);
  };


  // Event store query API




  return bridgeRelay;
}

