import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { kernels } from "../cljs-kernels.js";
import type {
  BridgeCapabilityAdvertisement,
  BridgeHealthReportPayload,
  BridgeHelloAckMessage,
  BridgeHelloMessage,
  BridgeRequestOpenMessage,
  BridgeResponseChunkMessage,
  BridgeResponseEndMessage,
  BridgeResponseHeadMessage,
  BridgeTopologySummary,
} from "./bridge-protocol.js";
import type { BridgeSendChannel } from "./bridge-send-channel.js";

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

interface FederationBridgeRelayImpl {
  listSessions(): FederationBridgeSessionRecord[];
  getSession(sessionId: string): FederationBridgeSessionRecord | undefined;
  rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404, payload: Record<string, unknown>): void;
  handleAuthorizedUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, identity: FederationBridgeAuthorizedIdentity): void;
  close(): Promise<void>;
  requestStream(sessionId: string, input: BridgeRequestInput): AsyncIterable<BridgeRelayResponseEvent>;
  requestJson(sessionId: string, input: BridgeRequestInput): Promise<BridgeRequestJsonResult>;
  registerSseChannel(sessionId: string, channel: BridgeSendChannel): void;
  unregisterChannel(sessionId: string, channel: BridgeSendChannel): void;
  getChannel(sessionId: string): BridgeSendChannel | undefined;
  completeSseHello(hello: BridgeHelloMessage, identity: FederationBridgeAuthorizedIdentity, sseChannel: BridgeSendChannel): BridgeHelloAckMessage;
  handleChannelMessage(sessionId: string, messageText: string, channel: BridgeSendChannel): void;
  acceptHello(hello: BridgeHelloMessage, identity: FederationBridgeAuthorizedIdentity): BridgeHelloAckMessage;
  handleDisconnect(sessionId: string | undefined): void;
}

interface BridgeRequestInput {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly requestContext?: BridgeRequestOpenMessage["requestContext"];
  readonly routingIntent?: BridgeRequestOpenMessage["routingIntent"];
}

interface BridgeRequestJsonResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly json: unknown;
}

/**
 * Bridge relay. Session, request-correlation and response-queue logic are the pure
 * transitions in proxx.federation.relay / .stream; sockets and timers live in the
 * CLJS edge (proxx.runtime.federation-relay). This class keeps the public surface.
 */
export class FederationBridgeRelay {
  private readonly impl = kernels.createBridgeRelay() as FederationBridgeRelayImpl;

  public listSessions(): FederationBridgeSessionRecord[] {
    return this.impl.listSessions();
  }

  public getSession(sessionId: string): FederationBridgeSessionRecord | undefined {
    return this.impl.getSession(sessionId);
  }

  public rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404, payload: Record<string, unknown>): void {
    this.impl.rejectUpgrade(socket, statusCode, payload);
  }

  public handleAuthorizedUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: FederationBridgeAuthorizedIdentity,
  ): void {
    this.impl.handleAuthorizedUpgrade(request, socket, head, identity);
  }

  public async close(): Promise<void> {
    await this.impl.close();
  }

  public requestStream(sessionId: string, input: BridgeRequestInput): AsyncIterable<BridgeRelayResponseEvent> {
    return this.impl.requestStream(sessionId, input);
  }

  public async requestJson(sessionId: string, input: BridgeRequestInput): Promise<BridgeRequestJsonResult> {
    return this.impl.requestJson(sessionId, input);
  }

  public registerSseChannel(sessionId: string, channel: BridgeSendChannel): void {
    this.impl.registerSseChannel(sessionId, channel);
  }

  public unregisterChannel(sessionId: string, channel: BridgeSendChannel): void {
    this.impl.unregisterChannel(sessionId, channel);
  }

  public getChannel(sessionId: string): BridgeSendChannel | undefined {
    return this.impl.getChannel(sessionId);
  }

  /** Called when an SSE session completes hello via POST; wires up the SSE send channel. */
  public completeSseHello(
    hello: BridgeHelloMessage,
    identity: FederationBridgeAuthorizedIdentity,
    sseChannel: BridgeSendChannel,
  ): BridgeHelloAckMessage {
    return this.impl.completeSseHello(hello, identity, sseChannel);
  }

  /** Handle an incoming message from a WebSocket or SSE+HTTP POST channel. */
  public handleChannelMessage(sessionId: string, messageText: string, channel: BridgeSendChannel): void {
    this.impl.handleChannelMessage(sessionId, messageText, channel);
  }

  public acceptHello(hello: BridgeHelloMessage, identity: FederationBridgeAuthorizedIdentity): BridgeHelloAckMessage {
    return this.impl.acceptHello(hello, identity);
  }

  private handleDisconnect(sessionId: string | undefined): void {
    this.impl.handleDisconnect(sessionId);
  }
}

export function createFederationBridgeRelay(): FederationBridgeRelay {
  return new FederationBridgeRelay();
}
