import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCapabilitiesMessage,
  type BridgeCapabilityAdvertisement,
  type BridgeChunkEncoding,
  type BridgeErrorMessage,
  type BridgeHealthReportMessage,
  type BridgeHealthReportPayload,
  type BridgeHelloMessage,
  type BridgeMessage,
  type BridgeRequestOpenMessage,
  type BridgeResponseChunkMessage,
  type BridgeResponseEndMessage,
  type BridgeResponseHeadMessage,
  type BridgeTopologySummary,
  parseBridgeMessageJson,
} from "./bridge-protocol.js";

export interface FederationBridgeAgentOptions {
  readonly relayUrl: string;
  readonly authorization?: string;
  readonly ownerSubject: string;
  readonly peerDid: string;
  readonly clusterId: string;
  readonly agentId: string;
  readonly environment: string;
  readonly bridgeAgentVersion: string;
  readonly authMode: BridgeHelloMessage["authMode"];
  readonly labels?: readonly string[];
  readonly topology?: BridgeTopologySummary;
  readonly capabilitiesHash?: string;
  readonly getCapabilities?: () => Promise<readonly BridgeCapabilityAdvertisement[]> | readonly BridgeCapabilityAdvertisement[];
  readonly getHealth?: () => Promise<BridgeHealthReportPayload> | BridgeHealthReportPayload;
  readonly handleRequest?: (input: { readonly request: BridgeRequestOpenMessage; readonly bodyText: string }) => Promise<BridgeRequestHandlerResult>;
  readonly handshakeDeadlineMs?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
}

type BridgeResponseProvenance = Pick<BridgeResponseEndMessage, "servedByClusterId" | "servedByGroupId" | "servedByNodeId" | "providerId" | "accountId">;

export type BridgeBufferedRequestResponse = BridgeResponseProvenance & {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly encoding?: BridgeChunkEncoding;
  readonly usage?: BridgeResponseEndMessage["usage"];
};

export type BridgeRequestHandlerStreamEvent =
  | ({ readonly type: "response_head"; readonly status: number; readonly headers?: Readonly<Record<string, string>> } & BridgeResponseProvenance)
  | ({ readonly type: "response_chunk"; readonly chunk: string; readonly encoding?: BridgeChunkEncoding; readonly final?: boolean } & BridgeResponseProvenance)
  | ({ readonly type: "response_end"; readonly usage?: BridgeResponseEndMessage["usage"] } & BridgeResponseProvenance);

export type BridgeRequestHandlerResult = BridgeBufferedRequestResponse | AsyncIterable<BridgeRequestHandlerStreamEvent>;

export interface FederationBridgeAgentSnapshot {
  readonly state: "idle" | "connecting" | "connected" | "reconnecting" | "stopped";
  readonly sessionId?: string;
  readonly connectedAt?: string;
  readonly lastSentAt?: string;
  readonly lastReceivedAt?: string;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly at: string;
  };
  readonly reconnectAttempt: number;
}

function normalizeWsText(data: unknown): string {
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

function isAsyncIterable(value: BridgeRequestHandlerResult): value is AsyncIterable<BridgeRequestHandlerStreamEvent> {
  return typeof (value as AsyncIterable<BridgeRequestHandlerStreamEvent>)[Symbol.asyncIterator] === "function";
}

export class FederationBridgeAgent {
  private webSocket: WebSocket | undefined;
  private state: FederationBridgeAgentSnapshot["state"] = "idle";
  private sessionId: string | undefined;
  private connectedAt: string | undefined;
  private lastSentAt: string | undefined;
  private lastReceivedAt: string | undefined;
  private lastError: FederationBridgeAgentSnapshot["lastError"];
  private reconnectAttempt = 0;
  private heartbeatSequence = 0;
  private heartbeatIntervalMs = 15_000;
  private readonly pendingInboundRequests = new Map<string, { readonly request: BridgeRequestOpenMessage; readonly chunks: string[] }>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private startPromise: Promise<void> | undefined;

  public constructor(private readonly options: FederationBridgeAgentOptions) {}

  public snapshot(): FederationBridgeAgentSnapshot {
    return {
      state: this.state,
      sessionId: this.sessionId,
      connectedAt: this.connectedAt,
      lastSentAt: this.lastSentAt,
      lastReceivedAt: this.lastReceivedAt,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  public async start(): Promise<void> {
    this.stopped = false;
    if (this.state === "connected" || this.state === "connecting") {
      return this.startPromise ?? Promise.resolve();
    }
    this.clearReconnectTimer();
    this.startPromise = this.connect(false);

    // Handle transient relay outages during startup gracefully.
    // If the initial connection fails, schedule reconnection and resolve
    // instead of propagating the error. Callers can use snapshot() to
    // monitor connection state.
    try {
      await this.startPromise;
    } catch (error) {
      this.recordError({
        code: "bridge_initial_connection_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
      if (!this.stopped) {
        this.scheduleReconnect();
      }
      // Resolve successfully even on initial failure - the agent will
      // continue attempting reconnection in the background.
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeatTimer();
    this.clearReconnectTimer();
    this.state = "stopped";

    const ws = this.webSocket;
    this.webSocket = undefined;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
      return;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }

  private async connect(isReconnect: boolean): Promise<void> {
    this.state = isReconnect ? "reconnecting" : "connecting";

    const headers: Record<string, string> = {};
    if (typeof this.options.authorization === "string" && this.options.authorization.trim().length > 0) {
      headers.authorization = this.options.authorization.trim();
    }

    const ws = new WebSocket(this.options.relayUrl, { headers });
    this.webSocket = ws;

    await new Promise<void>((resolve, reject) => {
      let helloAckReceived = false;
      let settled = false;
      let handshakeTimer: NodeJS.Timeout | undefined;

      const clearHandshakeTimer = () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
      };

      const settleResolve = () => {
        if (!settled) {
          clearHandshakeTimer();
          settled = true;
          resolve();
        }
      };
      const settleReject = (error: unknown) => {
        if (!settled) {
          clearHandshakeTimer();
          settled = true;
          reject(error);
        }
      };

      ws.once("open", () => {
        const hello: BridgeHelloMessage = {
          type: "hello",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          sentAt: new Date().toISOString(),
          traceId: randomUUID(),
          ownerSubject: this.options.ownerSubject,
          clusterId: this.options.clusterId,
          agentId: this.options.agentId,
          peerDid: this.options.peerDid,
          environment: this.options.environment,
          bridgeAgentVersion: this.options.bridgeAgentVersion,
          authMode: this.options.authMode,
          capabilitiesHash: this.options.capabilitiesHash,
          labels: [...(this.options.labels ?? [])],
          topology: this.options.topology,
        };
        this.lastSentAt = hello.sentAt;
        ws.send(JSON.stringify(hello));

        const handshakeDeadlineMs = this.options.handshakeDeadlineMs ?? 10_000;
        handshakeTimer = setTimeout(() => {
          const error = new Error(`bridge hello_ack was not received within ${handshakeDeadlineMs}ms`);
          this.recordError({
            code: "bridge_hello_ack_timeout",
            message: error.message,
            retryable: true,
          });
          ws.close(1008, "hello_ack timeout");
          settleReject(error);
        }, handshakeDeadlineMs);
      });

      ws.on("message", async (data, isBinary) => {
        if (isBinary) {
          this.recordError({ code: "bridge_binary_frames_not_supported", message: "binary websocket frames are not supported in bridge-ws-v0", retryable: false });
          ws.close(1003, "binary frames not supported");
          settleReject(new Error("binary websocket frames are not supported in bridge-ws-v0"));
          return;
        }

        try {
          const parsed = parseBridgeMessageJson(normalizeWsText(data));
          this.lastReceivedAt = parsed.sentAt;
          await this.handleMessage(parsed, ws, () => {
            helloAckReceived = true;
            settleResolve();
          });
        } catch (error) {
          this.recordError({
            code: "bridge_message_invalid",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
          ws.close(1008, "invalid bridge message");
          settleReject(error);
        }
      });

      ws.on("error", (error) => {
        clearHandshakeTimer();
        this.recordError({
          code: "bridge_socket_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
        settleReject(error);
      });

      ws.on("close", () => {
        clearHandshakeTimer();
        this.clearHeartbeatTimer();
        this.webSocket = undefined;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
        if (!settled && !helloAckReceived) {
          settleReject(new Error("bridge socket closed before hello_ack"));
        }
      });
    });
  }

  private async handleMessage(message: BridgeMessage, ws: WebSocket, onConnected: () => void): Promise<void> {
    switch (message.type) {
      case "hello_ack":
        this.sessionId = message.sessionId;
        this.connectedAt = message.sentAt;
        this.heartbeatIntervalMs = message.heartbeatIntervalMs;
        this.reconnectAttempt = 0;
        this.heartbeatSequence = 0;
        this.state = "connected";
        await this.publishSnapshot(ws);
        this.startHeartbeatLoop(ws);
        onConnected();
        return;
      case "error":
        this.recordError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
        });
        return;
      case "request_open":
        if (message.method === "GET") {
          await this.handleRequestOpen(message, "", ws);
          return;
        }
        this.pendingInboundRequests.set(message.streamId, { request: message, chunks: [] });
        return;
      case "request_chunk": {
        const pending = this.pendingInboundRequests.get(message.streamId);
        if (!pending) {
          this.sendError(ws, {
            streamId: message.streamId,
            code: "bridge_request_stream_missing",
            message: `received request chunk for unknown stream ${message.streamId}`,
            retryable: false,
          });
          return;
        }
        const decoded = message.encoding === "base64"
          ? Buffer.from(message.chunk, "base64").toString("utf8")
          : message.chunk;
        pending.chunks.push(decoded);
        if (message.final) {
          this.pendingInboundRequests.delete(message.streamId);
          await this.handleRequestOpen(pending.request, pending.chunks.join(""), ws);
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleRequestOpen(message: BridgeRequestOpenMessage, bodyText: string, ws: WebSocket): Promise<void> {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.options.handleRequest) {
      this.sendError(ws, {
        streamId: message.streamId,
        code: "bridge_request_handler_missing",
        message: `bridge agent has no request handler for ${message.method} ${message.path}`,
        retryable: false,
      });
      return;
    }

    try {
      const result = await this.options.handleRequest({ request: message, bodyText });
      if (isAsyncIterable(result)) {
        let sawHead = false;
        let sawEnd = false;
        let lastProvenance: BridgeResponseProvenance | undefined;

        for await (const event of result) {
          if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
            return;
          }

          lastProvenance = this.mergeResponseProvenance(lastProvenance, event);

          switch (event.type) {
            case "response_head":
              sawHead = true;
              this.sendResponseHeadMessage(ws, message.streamId, event.status, event.headers ?? {}, event);
              break;
            case "response_chunk":
              if (!sawHead) {
                sawHead = true;
                this.sendResponseHeadMessage(ws, message.streamId, 200, {}, event);
              }
              this.sendResponseChunkMessage(ws, message.streamId, event.chunk, event.encoding ?? "utf8", event.final ?? false, event);
              break;
            case "response_end":
              if (!sawHead) {
                sawHead = true;
                this.sendResponseHeadMessage(ws, message.streamId, 200, {}, event);
              }
              sawEnd = true;
              this.sendResponseEndMessage(ws, message.streamId, event.usage, event);
              break;
            default:
              break;
          }
        }

        if (!sawHead) {
          this.sendResponseHeadMessage(ws, message.streamId, 200, {}, lastProvenance);
        }
        if (!sawEnd) {
          this.sendResponseEndMessage(ws, message.streamId, undefined, lastProvenance);
        }
        return;
      }

      this.sendResponseHeadMessage(ws, message.streamId, result.status, result.headers ?? {}, result);

      if (typeof result.body === "string" && result.body.length > 0) {
        this.sendResponseChunkMessage(ws, message.streamId, result.body, result.encoding ?? "utf8", true, result);
      }

      this.sendResponseEndMessage(ws, message.streamId, result.usage, result);
    } catch (error) {
      this.sendError(ws, {
        streamId: message.streamId,
        code: "bridge_request_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private mergeResponseProvenance(
    base: BridgeResponseProvenance | undefined,
    update: BridgeResponseProvenance | undefined,
  ): BridgeResponseProvenance {
    return {
      servedByClusterId: update?.servedByClusterId ?? base?.servedByClusterId ?? this.options.clusterId,
      servedByGroupId: update?.servedByGroupId ?? base?.servedByGroupId,
      servedByNodeId: update?.servedByNodeId ?? base?.servedByNodeId,
      providerId: update?.providerId ?? base?.providerId,
      accountId: update?.accountId ?? base?.accountId,
    };
  }

  private sendResponseHeadMessage(
    ws: WebSocket,
    streamId: string,
    status: number,
    headers: Readonly<Record<string, string>>,
    provenance: BridgeResponseProvenance | undefined,
  ): void {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const resolvedProvenance = this.mergeResponseProvenance(undefined, provenance);
    const responseHead: BridgeResponseHeadMessage = {
      type: "response_head",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      status,
      headers,
      ...resolvedProvenance,
    };
    this.lastSentAt = responseHead.sentAt;
    ws.send(JSON.stringify(responseHead));
  }

  private sendResponseChunkMessage(
    ws: WebSocket,
    streamId: string,
    chunk: string,
    encoding: BridgeChunkEncoding,
    final: boolean,
    provenance: BridgeResponseProvenance | undefined,
  ): void {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const resolvedProvenance = this.mergeResponseProvenance(undefined, provenance);
    const responseChunk: BridgeResponseChunkMessage = {
      type: "response_chunk",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      chunk,
      encoding,
      final,
      ...resolvedProvenance,
    };
    this.lastSentAt = responseChunk.sentAt;
    ws.send(JSON.stringify(responseChunk));
  }

  private sendResponseEndMessage(
    ws: WebSocket,
    streamId: string,
    usage: BridgeResponseEndMessage["usage"],
    provenance: BridgeResponseProvenance | undefined,
  ): void {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const resolvedProvenance = this.mergeResponseProvenance(undefined, provenance);
    const responseEnd: BridgeResponseEndMessage = {
      type: "response_end",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      usage,
      ...resolvedProvenance,
    };
    this.lastSentAt = responseEnd.sentAt;
    ws.send(JSON.stringify(responseEnd));
  }

  private startHeartbeatLoop(ws: WebSocket): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      void this.publishSnapshot(ws).catch((error) => {
        this.recordError({
          code: "bridge_publish_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      });
    }, this.heartbeatIntervalMs);
  }

  private async publishSnapshot(ws: WebSocket): Promise<void> {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const heartbeat = {
      type: "heartbeat",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      sequence: ++this.heartbeatSequence,
      activeStreams: 0,
      queuedRequests: 0,
    } as const;
    this.lastSentAt = heartbeat.sentAt;
    ws.send(JSON.stringify(heartbeat));

    const capabilities: BridgeCapabilitiesMessage = {
      type: "capabilities",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      capabilities: this.options.getCapabilities ? [...await this.options.getCapabilities()] : [],
    };
    this.lastSentAt = capabilities.sentAt;
    ws.send(JSON.stringify(capabilities));

    const health: BridgeHealthReportMessage = {
      type: "health_report",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      health: this.options.getHealth
        ? await this.options.getHealth()
        : {
            processHealthy: true,
            upstreamHealthy: true,
            availableAccountCount: 0,
            localOauthBootstrapReady: false,
            nodes: [],
          },
    };
    this.lastSentAt = health.sentAt;
    ws.send(JSON.stringify(health));
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const minMs = this.options.reconnectMinMs ?? 500;
    const maxMs = this.options.reconnectMaxMs ?? 5_000;
    const delayMs = Math.min(maxMs, minMs * 2 ** Math.max(0, this.reconnectAttempt - 1));
    this.state = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.startPromise = this.connect(true).catch(() => undefined);
    }, delayMs);
  }

  private recordError(input: Pick<BridgeErrorMessage, "code" | "message" | "retryable">): void {
    this.lastError = {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      at: new Date().toISOString(),
    };
  }

  private sendError(
    ws: WebSocket,
    input: Pick<BridgeErrorMessage, "code" | "message" | "retryable"> & { readonly streamId?: string },
  ): void {
    if (!this.sessionId || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload: BridgeErrorMessage = {
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      streamId: input.streamId,
      sentAt: new Date().toISOString(),
      traceId: randomUUID(),
      ownerSubject: this.options.ownerSubject,
      clusterId: this.options.clusterId,
      agentId: this.options.agentId,
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    };
    this.lastSentAt = payload.sentAt;
    this.recordError(payload);
    ws.send(JSON.stringify(payload));
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

export function createFederationBridgeAgent(options: FederationBridgeAgentOptions): FederationBridgeAgent {
  return new FederationBridgeAgent(options);
}
