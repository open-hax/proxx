import { kernels } from "../cljs-kernels.js";
import type {
  BridgeCapabilityAdvertisement,
  BridgeChunkEncoding,
  BridgeHealthReportPayload,
  BridgeHelloMessage,
  BridgeRequestOpenMessage,
  BridgeResponseEndMessage,
  BridgeTopologySummary,
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

interface FederationBridgeAgentImpl {
  snapshot(): FederationBridgeAgentSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Bridge agent. What to say, what to remember and when to back off are the pure
 * transitions in proxx.federation.agent; the socket, timers and request handler
 * are the CLJS edge (proxx.runtime.federation-agent). This class keeps the public surface.
 */
export class FederationBridgeAgent {
  private readonly impl: FederationBridgeAgentImpl;

  public constructor(options: FederationBridgeAgentOptions) {
    this.impl = kernels.createBridgeAgent(options) as FederationBridgeAgentImpl;
  }

  public snapshot(): FederationBridgeAgentSnapshot {
    return this.impl.snapshot();
  }

  public async start(): Promise<void> {
    await this.impl.start();
  }

  public async stop(): Promise<void> {
    await this.impl.stop();
  }
}

export function createFederationBridgeAgent(options: FederationBridgeAgentOptions): FederationBridgeAgent {
  return new FederationBridgeAgent(options);
}
