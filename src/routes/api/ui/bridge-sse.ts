import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type {
  FederationBridgeAuthorizedIdentity,
  FederationBridgeRelay,
  FederationBridgeSessionRecord,
} from "../../../lib/federation/bridge-relay.js";
import { createSseBridgeSendChannel, formatSseEvent } from "../../../lib/federation/sse-bridge-channel.js";
import {
  parseBridgeMessageJson,
  type BridgeHelloMessage,
} from "../../../lib/federation/bridge-protocol.js";
import type { UiRouteDependencies } from "../../types.js";
import {
  authCanManageFederation,
  readCookieValue,
} from "../../shared/ui-auth.js";
import { resolveRequestAuth } from "../../../lib/request-auth.js";

export const BRIDGE_SSE_PROTOCOL_VERSION = "bridge-sse-v0" as const;

function identityCanAccessSession(
  identity: FederationBridgeAuthorizedIdentity,
  session: FederationBridgeSessionRecord,
): boolean {
  if (identity.authKind === "legacy_admin") {
    return true;
  }

  const identitySubject = identity.subject?.trim() ?? "";
  const sessionSubject = session.authSubject?.trim() ?? "";
  if (identitySubject.length === 0 || sessionSubject.length === 0 || identitySubject !== sessionSubject) {
    return false;
  }

  return (identity.tenantId?.trim() ?? "") === (session.tenantId?.trim() ?? "");
}

function setSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();
}

async function resolveBridgeAuth(
  request: FastifyRequest,
  deps: UiRouteDependencies,
): Promise<FederationBridgeAuthorizedIdentity | undefined> {
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
    return undefined;
  }
  if (!authCanManageFederation(auth)) {
    return undefined;
  }

  return {
    authKind: auth.kind === "legacy_admin" ? "legacy_admin" : "ui_session",
    subject: auth.subject,
    tenantId: auth.tenantId,
  };
}

export async function registerBridgeSseRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  bridgeRelay: FederationBridgeRelay,
): Promise<void> {
  /**
   * SSE GET endpoint: Agent opens this to RECEIVE relay→agent messages.
   *
   * Flow:
   * 1. Agent connects GET /api/ui/federation/bridge/sse?sessionId=<sid>
   * 2. Server sets up SSE channel, registers it in the relay
   * 3. All relay→agent messages (hello_ack, request_open, request_chunk, error) are pushed via this SSE stream
   * 4. Keepalive comments sent every 15s
   *
   * If sessionId is not yet known (pre-hello), the SSE connection is held open
   * but no session channel is registered. The agent must POST hello first,
   * then reconnect SSE with the assigned sessionId.
   */
  app.get("/api/ui/federation/bridge/sse", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveBridgeAuth(request, deps);
    if (!identity) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const sessionId = (request.query as Record<string, string>).sessionId?.trim();

    if (sessionId) {
      const session = bridgeRelay.getSession(sessionId);
      if (!session || session.state !== "connected") {
        reply.code(404).send({ error: "session_not_found", message: `session ${sessionId} not found or not connected` });
        return;
      }

      if (!identityCanAccessSession(identity, session)) {
        reply.code(403).send({ error: "forbidden", message: `session ${sessionId} does not belong to the current identity` });
        return;
      }
    }

    setSseHeaders(reply);

    const channel = createSseBridgeSendChannel(reply.raw);

    if (sessionId) {
      
      bridgeRelay.registerSseChannel(sessionId, channel);

      reply.raw.write(formatSseEvent("session_bound", {
        sessionId,
        sentAt: new Date().toISOString(),
        message: "SSE channel bound to bridge session",
      }));

      reply.raw.on("close", () => {
        bridgeRelay.unregisterChannel(sessionId, channel);
      });
    } else {
      reply.raw.write(formatSseEvent("sse_open", {
        protocolVersion: BRIDGE_SSE_PROTOCOL_VERSION,
        sentAt: new Date().toISOString(),
        message: "SSE connection established. POST hello first, then reconnect with sessionId.",
      }));
    }

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

  /**
   * POST hello: Agent sends this to initiate a bridge session via SSE+HTTP.
   * Returns hello_ack with sessionId. Agent then reconnects SSE with that sessionId.
   */
  app.post("/api/ui/federation/bridge/sse/hello", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveBridgeAuth(request, deps);
    if (!identity) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    let messageText: string;
    if (typeof request.body === "string") {
      messageText = request.body;
    } else if (request.body && typeof request.body === "object") {
      messageText = JSON.stringify(request.body);
    } else {
      reply.code(400).send({ error: "invalid_body", message: "request body must be JSON" });
      return;
    }

    let parsed: ReturnType<typeof parseBridgeMessageJson>;
    try {
      parsed = parseBridgeMessageJson(messageText);
    } catch (error) {
      reply.code(400).send({ error: "invalid_message", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (parsed.type !== "hello") {
      reply.code(400).send({ error: "invalid_message_type", message: "this endpoint only accepts hello messages" });
      return;
    }

    const helloAck = bridgeRelay.acceptHello(parsed as BridgeHelloMessage, identity);

    reply.send({
      type: "hello_ack",
      protocolVersion: helloAck.protocolVersion,
      sessionId: helloAck.sessionId,
      sentAt: helloAck.sentAt,
      traceId: helloAck.traceId,
      ownerSubject: helloAck.ownerSubject,
      clusterId: helloAck.clusterId,
      agentId: helloAck.agentId,
      heartbeatIntervalMs: helloAck.heartbeatIntervalMs,
      maxConcurrentStreams: helloAck.maxConcurrentStreams,
      maxFrameBytes: helloAck.maxFrameBytes,
      sseReconnectUrl: `/api/ui/federation/bridge/sse?sessionId=${helloAck.sessionId}`,
    });
  });

  /**
   * POST message: Agent sends heartbeat, capabilities, response_head/chunk/end, error messages.
   * Requires x-bridge-session-id header.
   * Error responses from relay are sent back through the SSE channel, not in the HTTP response.
   */
  app.post("/api/ui/federation/bridge/sse/message", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveBridgeAuth(request, deps);
    if (!identity) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const sessionId = (request.headers["x-bridge-session-id"] as string | undefined)?.trim();
    if (!sessionId) {
      reply.code(400).send({ error: "missing_session_id", message: "x-bridge-session-id header required" });
      return;
    }

    const session = bridgeRelay.getSession(sessionId);
    if (!session || session.state !== "connected") {
      reply.code(404).send({ error: "session_not_found", message: `session ${sessionId} not found or disconnected` });
      return;
    }

    if (!identityCanAccessSession(identity, session)) {
      reply.code(403).send({ error: "forbidden", message: `session ${sessionId} does not belong to the current identity` });
      return;
    }

    let messageText: string;
    if (typeof request.body === "string") {
      messageText = request.body;
    } else if (request.body && typeof request.body === "object") {
      messageText = JSON.stringify(request.body);
    } else {
      reply.code(400).send({ error: "invalid_body", message: "request body must be JSON" });
      return;
    }

    let parsed: ReturnType<typeof parseBridgeMessageJson>;
    try {
      parsed = parseBridgeMessageJson(messageText);
    } catch (error) {
      reply.code(400).send({ error: "invalid_message", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (parsed.type === "hello") {
      reply.code(400).send({ error: "duplicate_hello", message: "use /api/ui/federation/bridge/sse/hello for initial hello" });
      return;
    }

    const channel = bridgeRelay.getChannel(sessionId);
    if (!channel || !channel.isOpen) {
      reply.code(410).send({ error: "channel_not_found", message: `session ${sessionId} has no active SSE channel` });
      return;
    }

    bridgeRelay.handleChannelMessage(sessionId, messageText, channel);

    reply.send({ type: "ack", sessionId, sentAt: new Date().toISOString() });
  });
}
