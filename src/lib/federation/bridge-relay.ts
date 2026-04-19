import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeMessageJson,
  type BridgeCapabilitiesMessage,
  type BridgeCapabilityAdvertisement,
  type BridgeErrorMessage,
  type BridgeHealthReportMessage,
  type BridgeHealthReportPayload,
  type BridgeHelloAckMessage,
  type BridgeHelloMessage,
  type BridgeRequestOpenMessage,
  type BridgeResponseChunkMessage,
  type BridgeResponseEndMessage,
  type BridgeResponseHeadMessage,
  type BridgeTopologySummary,
} from "./bridge-protocol.js";

export interface FederationBridgeAuthorizedIdentity {
  readonly authKind: "legacy_admin" | "ui_session";
  readonly subject?: string;
  readonly tenantId?: string;
}

export interface FederationBridgeSessionRecord {
  readonly sessionId: string;
  readonly state: "connected" | "disconnected";
  readonly connectedAt: string;
  readonly lastSeenAt: string;
  readonly disconnectedAt?: string;
  readonly peerDid: string;
  readonly ownerSubject: string;
  readonly clusterId: string;
  readonly agentId: string;
  readonly environment: string;
  readonly bridgeAgentVersion: string;
  readonly authMode: string;
  readonly authKind: FederationBridgeAuthorizedIdentity["authKind"];
  readonly authSubject?: string;
  readonly tenantId?: string;
  readonly labels: readonly string[];
  readonly topology?: BridgeTopologySummary;
  readonly capabilities: readonly BridgeCapabilityAdvertisement[];
  readonly health?: BridgeHealthReportPayload;
  readonly recentError?: {
    readonly at: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly activeStreams?: number;
  readonly queuedRequests?: number;
  readonly lastHeartbeatSequence?: number;
}

export type BridgeRelayResponseEvent = BridgeResponseHeadMessage | BridgeResponseChunkMessage | BridgeResponseEndMessage;

interface PendingBridgeRequest {
  readonly sessionId: string;
  readonly streamId: string;
  readonly timeout: NodeJS.Timeout;
  readonly events: BridgeRelayResponseEvent[];
  readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<BridgeRelayResponseEvent>) => void;
    readonly reject: (error: Error) => void;
  }>;
  done: boolean;
  failure?: Error;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type MutableFederationBridgeSessionRecord = Mutable<FederationBridgeSessionRecord>;

function cloneSession(session: MutableFederationBridgeSessionRecord): FederationBridgeSessionRecord {
  return {
    ...session,
    labels: [...session.labels],
    topology: session.topology
      ? {
          groups: session.topology.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
          nodes: session.topology.nodes.map((node) => ({ ...node, labels: [...node.labels] })),
          defaultExecutionPolicy: session.topology.defaultExecutionPolicy,
        }
      : undefined,
    capabilities: session.capabilities.map((capability) => ({
      ...capability,
      modelPrefixes: [...capability.modelPrefixes],
      models: [...capability.models],
      paths: capability.paths ? [...capability.paths] : undefined,
      routes: capability.routes ? [...capability.routes] : undefined,
      topologyTargets: capability.topologyTargets.map((target) => ({ ...target })),
    })),
    health: session.health
      ? {
          ...session.health,
          nodes: session.health.nodes.map((node) => ({ ...node })),
        }
      : undefined,
    recentError: session.recentError ? { ...session.recentError } : undefined,
  };
}

function normalizeWsText(data: Parameters<WebSocket["on"]>[1] extends never ? never : unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => Buffer.isBuffer(entry) ? entry : Buffer.from(entry))).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(String(data)).toString("utf8");
}

function writeUpgradeResponse(socket: Duplex, statusCode: number, statusText: string, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: application/json; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
  );
  socket.destroy();
}

export class FederationBridgeRelay {
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, MutableFederationBridgeSessionRecord>();
  private readonly connections = new Map<string, WebSocket>();
  private readonly pendingRequests = new Map<string, PendingBridgeRequest>();

  /** Remove disconnected sessions older than the retention window to prevent unbounded growth. */
  private pruneDisconnectedSessions(maxAgeMs = 300_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.state === "disconnected" && session.disconnectedAt) {
        const disconnectedTime = new Date(session.disconnectedAt).getTime();
        if (disconnectedTime < cutoff) {
          this.sessions.delete(sessionId);
        }
      }
    }
  }

  public listSessions(): FederationBridgeSessionRecord[] {
    return [...this.sessions.values()]
      .map(cloneSession)
      .sort((left, right) => right.connectedAt.localeCompare(left.connectedAt));
  }

  public getSession(sessionId: string): FederationBridgeSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  public rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404, payload: Record<string, unknown>): void {
    const statusText = statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : "Not Found";
    writeUpgradeResponse(socket, statusCode, statusText, payload);
  }

  public handleAuthorizedUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: FederationBridgeAuthorizedIdentity,
  ): void {
    this.wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleConnection(webSocket, identity);
    });
  }

  public async close(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      this.failPendingRequest(pending, new Error("bridge relay closed"));
    }
    this.pendingRequests.clear();
    for (const client of this.wsServer.clients) {
      client.close();
    }
    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });
  }

  public requestStream(sessionId: string, input: {
    readonly method?: "GET" | "POST";
    readonly path: string;
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly requestContext?: BridgeRequestOpenMessage["requestContext"];
    readonly routingIntent?: BridgeRequestOpenMessage["routingIntent"];
  }): AsyncIterable<BridgeRelayResponseEvent> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "connected") {
      throw new Error(`bridge session ${sessionId} is not connected`);
    }

    const webSocket = this.connections.get(sessionId);
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`bridge session ${sessionId} has no open websocket connection`);
    }

    const streamId = randomUUID();
    const request: BridgeRequestOpenMessage = {
      type: "request_open",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId,
      streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: session.ownerSubject,
      clusterId: session.clusterId,
      agentId: session.agentId,
      method: input.method ?? "GET",
      path: input.path,
      headers: input.headers ?? { accept: "application/json" },
      requestContext: input.requestContext,
      routingIntent: input.routingIntent,
      hopCount: 0,
    };

    const timeout = setTimeout(() => {
      const pending = this.pendingRequests.get(streamId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(streamId);
      this.failPendingRequest(pending, new Error(`bridge request timed out for ${input.path}`));
    }, input.timeoutMs);

    const pending: PendingBridgeRequest = {
      sessionId,
      streamId,
      timeout,
      events: [],
      waiters: [],
      done: false,
    };

    this.pendingRequests.set(streamId, pending);
    webSocket.send(JSON.stringify(request));
    if (typeof input.body === "string" && input.body.length > 0) {
      webSocket.send(JSON.stringify({
        type: "request_chunk",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        sessionId,
        streamId,
        sentAt: new Date().toISOString(),
        traceId: randomUUID(),
        ownerSubject: session.ownerSubject,
        clusterId: session.clusterId,
        agentId: session.agentId,
        chunk: input.body,
        encoding: "utf8",
        final: true,
      }));
    }

    return this.createResponseStream(streamId, pending);
  }

  public async requestJson(sessionId: string, input: {
    readonly method?: "GET" | "POST";
    readonly path: string;
    readonly timeoutMs: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly requestContext?: BridgeRequestOpenMessage["requestContext"];
    readonly routingIntent?: BridgeRequestOpenMessage["routingIntent"];
  }): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly json: unknown }> {
    const events = this.requestStream(sessionId, input);
    let status = 200;
    let headers: Readonly<Record<string, string>> = {};
    const chunks: string[] = [];

    for await (const event of events) {
      switch (event.type) {
        case "response_head":
          status = event.status;
          headers = event.headers;
          break;
        case "response_chunk": {
          const decoded = event.encoding === "base64"
            ? Buffer.from(event.chunk, "base64").toString("utf8")
            : event.chunk;
          chunks.push(decoded);
          break;
        }
        case "response_end":
          break;
        default:
          break;
      }
    }

    const body = chunks.join("");
    let json: unknown;
    try {
      json = body.length > 0 ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }

    return { status, headers, body, json };
  }

  private handleConnection(webSocket: WebSocket, identity: FederationBridgeAuthorizedIdentity): void {
    let sessionId: string | undefined;

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.markErrorAndClose(webSocket, sessionId, "bridge_binary_frames_not_supported", "binary websocket frames are not supported in bridge-ws-v0", false);
        return;
      }

      let messageText: string;
      try {
        messageText = normalizeWsText(data);
      } catch (error) {
        this.markErrorAndClose(webSocket, sessionId, "bridge_message_decode_failed", error instanceof Error ? error.message : String(error), false);
        return;
      }

      try {
        const parsed = parseBridgeMessageJson(messageText);
        if (!sessionId) {
          if (parsed.type !== "hello") {
            this.markErrorAndClose(webSocket, undefined, "bridge_hello_required", "first bridge frame must be a hello message", false);
            return;
          }
          const helloAck = this.acceptHello(parsed, identity);
          sessionId = helloAck.sessionId;
          this.connections.set(sessionId, webSocket);
          webSocket.send(JSON.stringify(helloAck));
          return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          this.markErrorAndClose(webSocket, sessionId, "bridge_session_not_found", "bridge session not found", false);
          return;
        }
        if (parsed.sessionId && parsed.sessionId !== sessionId) {
          this.sendErrorFrame(webSocket, session, {
            code: "bridge_session_mismatch",
            message: `message sessionId ${parsed.sessionId} does not match active session ${sessionId}`,
            retryable: false,
            streamId: parsed.streamId,
          });
          return;
        }

        session.lastSeenAt = parsed.sentAt;
        switch (parsed.type) {
          case "heartbeat":
            session.lastHeartbeatSequence = parsed.sequence;
            session.activeStreams = parsed.activeStreams;
            session.queuedRequests = parsed.queuedRequests;
            break;
          case "capabilities":
            session.capabilities = cloneCapabilities(parsed);
            break;
          case "health_report":
            session.health = cloneHealth(parsed);
            break;
          case "response_head":
            this.handleResponseHead(parsed);
            break;
          case "response_chunk":
            this.handleResponseChunk(parsed);
            break;
          case "response_end":
            this.handleResponseEnd(parsed);
            break;
          case "error":
            if (parsed.streamId) {
              this.handleResponseError(parsed);
            }
            session.recentError = {
              at: parsed.sentAt,
              code: parsed.code,
              message: parsed.message,
              retryable: parsed.retryable,
            };
            break;
          case "hello":
            this.sendErrorFrame(webSocket, session, {
              code: "bridge_duplicate_hello",
              message: "bridge hello may only be sent once per session",
              retryable: false,
            });
            break;
          default:
            this.sendErrorFrame(webSocket, session, {
              code: "bridge_execution_not_implemented",
              message: `bridge message type ${parsed.type} is not implemented by the relay stub yet`,
              retryable: true,
              streamId: parsed.streamId,
            });
            break;
        }
      } catch (error) {
        this.markErrorAndClose(webSocket, sessionId, "bridge_message_invalid", error instanceof Error ? error.message : String(error), false);
      }
    });

    webSocket.on("close", () => {
      if (!sessionId) {
        return;
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        return;
      }
      this.connections.delete(sessionId);
      session.state = "disconnected";
      session.disconnectedAt = new Date().toISOString();
      for (const pending of [...this.pendingRequests.values()].filter((candidate) => candidate.sessionId === sessionId)) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(pending.streamId);
        this.failPendingRequest(pending, new Error(`bridge session ${sessionId} closed during request ${pending.streamId}`));
      }
    });
  }

  private createResponseStream(streamId: string, pending: PendingBridgeRequest): AsyncIterable<BridgeRelayResponseEvent> {
    const nextEvent = async (): Promise<IteratorResult<BridgeRelayResponseEvent>> => {
      if (pending.events.length > 0) {
        const event = pending.events.shift()!;
        return { value: event, done: false };
      }
      if (pending.failure) {
        throw pending.failure;
      }
      if (pending.done) {
        return { value: undefined, done: true };
      }
      return new Promise<IteratorResult<BridgeRelayResponseEvent>>((resolve, reject) => {
        pending.waiters.push({ resolve, reject });
      });
    };

    return {
      [Symbol.asyncIterator]: () => ({
        next: () => nextEvent(),
        return: async () => {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(streamId);
          pending.done = true;
          this.flushPendingDone(pending);
          return { value: undefined, done: true };
        },
      }),
    };
  }

  private pushPendingEvent(pending: PendingBridgeRequest, event: BridgeRelayResponseEvent): void {
    if (pending.waiters.length > 0) {
      pending.waiters.shift()!.resolve({ value: event, done: false });
      return;
    }
    pending.events.push(event);
  }

  private flushPendingDone(pending: PendingBridgeRequest): void {
    while (pending.waiters.length > 0) {
      pending.waiters.shift()!.resolve({ value: undefined, done: true });
    }
  }

  private failPendingRequest(pending: PendingBridgeRequest, error: Error): void {
    pending.failure = error;
    while (pending.waiters.length > 0) {
      pending.waiters.shift()!.reject(error);
    }
  }

  private acceptHello(hello: BridgeHelloMessage, identity: FederationBridgeAuthorizedIdentity): BridgeHelloAckMessage {
    const connectedAt = hello.sentAt;
    const sessionId = randomUUID();
    // Prune old disconnected sessions before adding a new one to prevent unbounded growth
    this.pruneDisconnectedSessions();
    this.sessions.set(sessionId, {
      sessionId,
      state: "connected",
      connectedAt,
      lastSeenAt: connectedAt,
      peerDid: hello.peerDid,
      ownerSubject: hello.ownerSubject,
      clusterId: hello.clusterId,
      agentId: hello.agentId,
      environment: hello.environment,
      bridgeAgentVersion: hello.bridgeAgentVersion,
      authMode: hello.authMode,
      authKind: identity.authKind,
      authSubject: identity.subject,
      tenantId: identity.tenantId,
      labels: [...hello.labels],
      topology: hello.topology
        ? {
            groups: hello.topology.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
            nodes: hello.topology.nodes.map((node) => ({ ...node, labels: [...node.labels] })),
            defaultExecutionPolicy: hello.topology.defaultExecutionPolicy,
          }
        : undefined,
      capabilities: [],
      health: undefined,
      recentError: undefined,
      activeStreams: 0,
      queuedRequests: 0,
      lastHeartbeatSequence: undefined,
    });

    return {
      type: "hello_ack",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: hello.ownerSubject,
      clusterId: hello.clusterId,
      agentId: hello.agentId,
      heartbeatIntervalMs: 15_000,
      maxConcurrentStreams: 32,
      maxFrameBytes: 256 * 1024,
    };
  }

  private sendErrorFrame(
    webSocket: WebSocket,
    session: MutableFederationBridgeSessionRecord,
    input: Pick<BridgeErrorMessage, "code" | "message" | "retryable"> & { readonly streamId?: string },
  ): void {
    const payload: BridgeErrorMessage = {
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      streamId: input.streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: session.ownerSubject,
      clusterId: session.clusterId,
      agentId: session.agentId,
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    };
    session.recentError = {
      at: payload.sentAt,
      code: payload.code,
      message: payload.message,
      retryable: payload.retryable,
    };
    webSocket.send(JSON.stringify(payload));
  }

  private markErrorAndClose(
    webSocket: WebSocket,
    sessionId: string | undefined,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sendErrorFrame(webSocket, session, { code, message, retryable });
      }
    }
    webSocket.close(1008, `${code}:${message}`.slice(0, 120));
  }

  private handleResponseHead(message: BridgeResponseHeadMessage): void {
    const pending = this.pendingRequests.get(message.streamId);
    if (!pending) {
      return;
    }
    this.pushPendingEvent(pending, message);
  }

  private handleResponseChunk(message: BridgeResponseChunkMessage): void {
    const pending = this.pendingRequests.get(message.streamId);
    if (!pending) {
      return;
    }
    this.pushPendingEvent(pending, message);
  }

  private handleResponseEnd(message: BridgeResponseEndMessage): void {
    const pending = this.pendingRequests.get(message.streamId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.streamId);
    pending.done = true;
    this.pushPendingEvent(pending, message);
    this.flushPendingDone(pending);
  }

  private handleResponseError(message: BridgeErrorMessage): void {
    const pending = message.streamId ? this.pendingRequests.get(message.streamId) : undefined;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(pending.streamId);
    this.failPendingRequest(pending, new Error(`${message.code}: ${message.message}`));
  }
}

function cloneCapabilities(message: BridgeCapabilitiesMessage): readonly BridgeCapabilityAdvertisement[] {
  return message.capabilities.map((capability) => ({
    ...capability,
    modelPrefixes: [...capability.modelPrefixes],
    models: [...capability.models],
    paths: capability.paths ? [...capability.paths] : undefined,
    routes: capability.routes ? [...capability.routes] : undefined,
    topologyTargets: capability.topologyTargets.map((target) => ({ ...target })),
  }));
}

function cloneHealth(message: BridgeHealthReportMessage): BridgeHealthReportPayload {
  return {
    ...message.health,
    nodes: message.health.nodes.map((node) => ({ ...node })),
  };
}

export function createFederationBridgeRelay(): FederationBridgeRelay {
  return new FederationBridgeRelay();
}
