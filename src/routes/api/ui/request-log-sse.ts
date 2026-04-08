import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { RequestLogWsIdentity, RequestLogWsSubscription } from "../../../lib/observability/request-log-ws-hub.js";
import type { RequestLogSseHub } from "../../../lib/observability/request-log-sse-hub.js";
import type { UiRouteDependencies } from "../../types.js";
import {
  authCanManageFederation,
  readCookieValue,
} from "../../shared/ui-auth.js";
import { resolveRequestAuth } from "../../../lib/request-auth.js";

function setSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();
}

function parseRequestLogRouteKind(value: string | undefined): RequestLogWsSubscription["routeKind"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "federated" || normalized === "bridge" || normalized === "routed" || normalized === "any") {
    return normalized;
  }
  return undefined;
}

export async function registerRequestLogSseRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  requestLogSseHub: RequestLogSseHub,
): Promise<void> {
  app.get("/api/v1/federation/observability/sse", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await resolveRequestAuth({
      allowUnauthenticated: false,
      proxyAuthToken: deps.config.proxyAuthToken,
      authorization: request.headers.authorization,
      cookieToken: readCookieValue(request.headers.cookie, "open_hax_proxy_auth_token"),
      oauthAccessToken: readCookieValue(request.headers.cookie, "proxy_auth"),
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

    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!authCanManageFederation(auth)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const identity: RequestLogWsIdentity = {
      authKind: auth.kind === "legacy_admin" ? "legacy_admin" : "ui_session",
      tenantId: auth.tenantId,
    };

    const query = request.query as Record<string, string>;
    const subscription: RequestLogWsSubscription = {
      ownerSubject: query.ownerSubject?.trim() || undefined,
      routeKind: parseRequestLogRouteKind(query.routeKind),
    };

    setSseHeaders(reply);

    requestLogSseHub.addClient(reply.raw, identity, subscription);

    const keepAlive = setInterval(() => {
      if (reply.raw.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, 15_000);

    reply.raw.on("close", () => {
      clearInterval(keepAlive);
    });

    request.raw.on("close", () => {
      clearInterval(keepAlive);
    });
  });
}