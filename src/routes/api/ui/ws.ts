import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../../types.js";
import { createFederationBridgeRelay, type FederationBridgeRelay } from "../../../lib/federation/bridge-relay.js";
import { RequestLogWsHub, type RequestLogWsSubscription } from "../../../lib/observability/request-log-ws-hub.js";
import {
  authCanManageFederation,
  readCookieValue,
} from "../../shared/ui-auth.js";
import { resolveRequestAuth, type ResolvedRequestAuth } from "../../../lib/request-auth.js";

function parseRequestLogRouteKind(value: string | undefined): RequestLogWsSubscription["routeKind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "federated" || normalized === "bridge" || normalized === "routed" || normalized === "any") {
    return normalized;
  }
  return undefined;
}

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<{ bridgeRelay: FederationBridgeRelay; requestLogWsHub: RequestLogWsHub }> {
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

  return { bridgeRelay, requestLogWsHub };
}
