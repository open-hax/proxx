import { kernels } from "../cljs-kernels.js";

export const BRIDGE_PROTOCOL_VERSION = "bridge-ws-v0" as const;

if (kernels.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
  throw new Error(`bridge protocol version mismatch: TypeScript ${BRIDGE_PROTOCOL_VERSION}, CLJS ${kernels.bridgeProtocolVersion}`);
}

export type BridgeProtocolVersion = typeof BRIDGE_PROTOCOL_VERSION;
export type BridgeAuthMode = "admin_key" | "at_did" | "did_signed_challenge";
export type BridgeAccountAuthType = "api_key" | "oauth_bearer" | "local" | "none";
export type BridgeCredentialMobility = "local_only" | "descriptor_only" | "importable" | "non_exportable" | "access_token_only";
export type BridgeChunkEncoding = "utf8" | "base64";
export type BridgeDefaultExecutionPolicy = "cluster_default" | "group_affinity" | "node_affinity";

export interface BridgeTopologyGroupSummary {
  readonly groupId: string;
  readonly nodeIds: readonly string[];
}

export interface BridgeTopologyNodeSummary {
  readonly groupId: string;
  readonly nodeId: string;
  readonly labels: readonly string[];
}

export interface BridgeTopologySummary {
  readonly groups: readonly BridgeTopologyGroupSummary[];
  readonly nodes: readonly BridgeTopologyNodeSummary[];
  readonly defaultExecutionPolicy?: BridgeDefaultExecutionPolicy;
}

export interface BridgeExecutionTarget {
  readonly groupId: string;
  readonly nodeId: string;
}

export interface BridgeCapabilityAdvertisement {
  readonly providerId: string;
  readonly modelPrefixes: readonly string[];
  readonly models: readonly string[];
  readonly paths?: readonly string[];
  readonly routes?: readonly string[];
  readonly authType: BridgeAccountAuthType;
  readonly accountCount: number;
  readonly availableAccountCount: number;
  readonly supportsModelsList: boolean;
  readonly supportsChatCompletions: boolean;
  readonly supportsResponses: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsWarmImport: boolean;
  readonly credentialMobility: BridgeCredentialMobility;
  readonly credentialOrigin: string;
  readonly lastHealthyAt?: string;
  readonly lastFailureAt?: string;
  readonly failureClass?: string;
  readonly topologyTargets: readonly BridgeExecutionTarget[];
}

export interface BridgeNodeHealthSummary {
  readonly groupId: string;
  readonly nodeId: string;
  readonly reachable: boolean;
  readonly lastHealthyAt?: string;
  readonly lastFailureAt?: string;
  readonly failureClass?: string;
}

export interface BridgeHealthReportPayload {
  readonly processHealthy: boolean;
  readonly upstreamHealthy: boolean;
  readonly availableAccountCount: number;
  readonly localOauthBootstrapReady: boolean;
  readonly queuedRequests?: number;
  readonly nodes: readonly BridgeNodeHealthSummary[];
}

export interface BridgeRequestContext {
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
}

export interface BridgeRoutingIntent {
  readonly providerId?: string;
  readonly model?: string;
  readonly accountId?: string;
}

export interface BridgeUsageSummary {
  readonly requestCount?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface BridgeBaseEnvelope {
  readonly type: string;
  readonly protocolVersion: BridgeProtocolVersion;
  readonly sessionId?: string;
  readonly streamId?: string;
  readonly sentAt: string;
  readonly traceId: string;
  readonly ownerSubject: string;
  readonly clusterId: string;
  readonly agentId: string;
  readonly groupId?: string;
  readonly nodeId?: string;
}

export interface BridgeHelloMessage extends BridgeBaseEnvelope {
  readonly type: "hello";
  readonly peerDid: string;
  readonly environment: string;
  readonly bridgeAgentVersion: string;
  readonly authMode: BridgeAuthMode;
  readonly capabilitiesHash?: string;
  readonly labels: readonly string[];
  readonly topology?: BridgeTopologySummary;
}

export interface BridgeHelloAckMessage extends BridgeBaseEnvelope {
  readonly type: "hello_ack";
  readonly sessionId: string;
  readonly heartbeatIntervalMs: number;
  readonly maxConcurrentStreams: number;
  readonly maxFrameBytes: number;
  readonly resumeToken?: string;
}

export interface BridgeHeartbeatMessage extends BridgeBaseEnvelope {
  readonly type: "heartbeat";
  readonly sequence: number;
  readonly activeStreams?: number;
  readonly queuedRequests?: number;
}

export interface BridgeCapabilitiesMessage extends BridgeBaseEnvelope {
  readonly type: "capabilities";
  readonly capabilities: readonly BridgeCapabilityAdvertisement[];
}

export interface BridgeHealthReportMessage extends BridgeBaseEnvelope {
  readonly type: "health_report";
  readonly health: BridgeHealthReportPayload;
}

export interface BridgeRequestOpenMessage extends BridgeBaseEnvelope {
  readonly type: "request_open";
  readonly streamId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestContext?: BridgeRequestContext;
  readonly routingIntent?: BridgeRoutingIntent;
  readonly originClusterId?: string;
  readonly originNodeId?: string;
  readonly hopCount: number;
}

export interface BridgeRequestChunkMessage extends BridgeBaseEnvelope {
  readonly type: "request_chunk";
  readonly streamId: string;
  readonly chunk: string;
  readonly encoding: BridgeChunkEncoding;
  readonly final: boolean;
}

export interface BridgeResponseHeadMessage extends BridgeBaseEnvelope {
  readonly type: "response_head";
  readonly streamId: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly servedByClusterId?: string;
  readonly servedByGroupId?: string;
  readonly servedByNodeId?: string;
  readonly providerId?: string;
  readonly accountId?: string;
}

export interface BridgeResponseChunkMessage extends BridgeBaseEnvelope {
  readonly type: "response_chunk";
  readonly streamId: string;
  readonly chunk: string;
  readonly encoding: BridgeChunkEncoding;
  readonly final: boolean;
  readonly servedByClusterId?: string;
  readonly servedByGroupId?: string;
  readonly servedByNodeId?: string;
  readonly providerId?: string;
  readonly accountId?: string;
}

export interface BridgeResponseEndMessage extends BridgeBaseEnvelope {
  readonly type: "response_end";
  readonly streamId: string;
  readonly usage?: BridgeUsageSummary;
  readonly servedByClusterId?: string;
  readonly servedByGroupId?: string;
  readonly servedByNodeId?: string;
  readonly providerId?: string;
  readonly accountId?: string;
}

export interface BridgeErrorMessage extends BridgeBaseEnvelope {
  readonly type: "error";
  readonly streamId?: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type BridgeMessage =
  | BridgeHelloMessage
  | BridgeHelloAckMessage
  | BridgeHeartbeatMessage
  | BridgeCapabilitiesMessage
  | BridgeHealthReportMessage
  | BridgeRequestOpenMessage
  | BridgeRequestChunkMessage
  | BridgeResponseHeadMessage
  | BridgeResponseChunkMessage
  | BridgeResponseEndMessage
  | BridgeErrorMessage;

/**
 * Parse and normalize a bridge-ws-v0 frame. The implementation is
 * `proxx.federation.protocol` (pure, Malli-validated); this keeps the typed entry points.
 */
export const parseBridgeMessage = (value: unknown): BridgeMessage => kernels.parseBridgeMessage(value);

export const parseBridgeMessageJson = (jsonText: string): BridgeMessage => kernels.parseBridgeMessageJson(jsonText);
