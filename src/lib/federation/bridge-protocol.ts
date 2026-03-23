import { asString, isRecord } from "../provider-utils.js";

export const BRIDGE_PROTOCOL_VERSION = "bridge-ws-v0" as const;

export type BridgeProtocolVersion = typeof BRIDGE_PROTOCOL_VERSION;
export type BridgeAuthMode = "admin_key" | "at_did" | "did_signed_challenge";
export type BridgeAccountAuthType = "api_key" | "oauth_bearer" | "local" | "none";
export type BridgeCredentialMobility = "local_only" | "descriptor_only" | "importable" | "non_exportable";
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

function requiredString(record: Record<string, unknown>, fieldName: string): string {
  const value = asString(record[fieldName])?.trim();
  if (!value) {
    throw new Error(`bridge message ${fieldName} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, fieldName: string): string | undefined {
  const value = asString(record[fieldName])?.trim();
  return value && value.length > 0 ? value : undefined;
}

function requiredBoolean(record: Record<string, unknown>, fieldName: string): boolean {
  const value = record[fieldName];
  if (typeof value !== "boolean") {
    throw new Error(`bridge message ${fieldName} must be a boolean`);
  }
  return value;
}

function requiredNonNegativeInteger(record: Record<string, unknown>, fieldName: string): number {
  const value = record[fieldName];
  if (typeof value !== "number" || !Number.isFinite(value) || Math.floor(value) !== value || value < 0) {
    throw new Error(`bridge message ${fieldName} must be a non-negative integer`);
  }
  return value;
}

function optionalNonNegativeInteger(record: Record<string, unknown>, fieldName: string): number | undefined {
  const value = record[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || Math.floor(value) !== value || value < 0) {
    throw new Error(`bridge message ${fieldName} must be a non-negative integer when present`);
  }
  return value;
}

function optionalIsoTimestamp(record: Record<string, unknown>, fieldName: string): string | undefined {
  const value = optionalString(record, fieldName);
  if (!value) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`bridge message ${fieldName} must be an ISO timestamp`);
  }
  return value;
}

function requiredIsoTimestamp(record: Record<string, unknown>, fieldName: string): string {
  const value = requiredString(record, fieldName);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`bridge message ${fieldName} must be an ISO timestamp`);
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, fieldName: string): readonly string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`bridge message ${fieldName} must be an array when present`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`bridge message ${fieldName}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function requiredStringRecord(record: Record<string, unknown>, fieldName: string): Readonly<Record<string, string>> {
  const value = record[fieldName];
  if (!isRecord(value)) {
    throw new Error(`bridge message ${fieldName} must be an object`);
  }

  const normalized: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim();
    const normalizedValue = typeof raw === "string" ? raw : undefined;
    if (!normalizedKey || normalizedValue === undefined) {
      throw new Error(`bridge message ${fieldName}.${key} must be a string header pair`);
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function optionalStringRecord(record: Record<string, unknown>, fieldName: string): Readonly<Record<string, string>> | undefined {
  if (record[fieldName] === undefined) {
    return undefined;
  }
  return requiredStringRecord(record, fieldName);
}

function readEnum<T extends string>(value: unknown, fieldName: string, allowed: readonly T[]): T {
  if (typeof value !== "string") {
    throw new Error(`bridge message ${fieldName} must be a string enum`);
  }
  const normalized = value.trim() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`bridge message ${fieldName} must be one of ${allowed.join(", ")}`);
  }
  return normalized;
}

function parseTopologySummary(value: unknown): BridgeTopologySummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bridge message topology must be an object when present");
  }

  const groupsValue = value.groups;
  const nodesValue = value.nodes;
  const groups = Array.isArray(groupsValue)
    ? groupsValue.map((entry, index) => parseTopologyGroup(entry, `topology.groups[${index}]`))
    : [];
  const nodes = Array.isArray(nodesValue)
    ? nodesValue.map((entry, index) => parseTopologyNode(entry, `topology.nodes[${index}]`))
    : [];
  const defaultExecutionPolicy = value.defaultExecutionPolicy === undefined
    ? undefined
    : readEnum(value.defaultExecutionPolicy, "topology.defaultExecutionPolicy", ["cluster_default", "group_affinity", "node_affinity"] as const);

  return {
    groups,
    nodes,
    defaultExecutionPolicy,
  };
}

function parseTopologyGroup(value: unknown, context: string): BridgeTopologyGroupSummary {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  const nodeIds = Array.isArray(value.nodeIds)
    ? value.nodeIds.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(`${context}.nodeIds[${index}] must be a non-empty string`);
      }
      return entry.trim();
    })
    : [];

  return {
    groupId: requiredString(value, "groupId"),
    nodeIds,
  };
}

function parseTopologyNode(value: unknown, context: string): BridgeTopologyNodeSummary {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return {
    groupId: requiredString(value, "groupId"),
    nodeId: requiredString(value, "nodeId"),
    labels: optionalStringArray(value, "labels"),
  };
}

function parseExecutionTarget(value: unknown, context: string): BridgeExecutionTarget {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return {
    groupId: requiredString(value, "groupId"),
    nodeId: requiredString(value, "nodeId"),
  };
}

function parseCapabilityAdvertisement(value: unknown, context: string): BridgeCapabilityAdvertisement {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  const topologyTargetsValue = value.topologyTargets;
  if (!Array.isArray(topologyTargetsValue)) {
    throw new Error(`${context}.topologyTargets must be an array`);
  }

  return {
    providerId: requiredString(value, "providerId"),
    modelPrefixes: optionalStringArray(value, "modelPrefixes"),
    models: optionalStringArray(value, "models"),
    paths: optionalStringArray(value, "paths"),
    routes: optionalStringArray(value, "routes"),
    authType: readEnum(value.authType, `${context}.authType`, ["api_key", "oauth_bearer", "local", "none"] as const),
    accountCount: requiredNonNegativeInteger(value, "accountCount"),
    availableAccountCount: requiredNonNegativeInteger(value, "availableAccountCount"),
    supportsModelsList: requiredBoolean(value, "supportsModelsList"),
    supportsChatCompletions: requiredBoolean(value, "supportsChatCompletions"),
    supportsResponses: requiredBoolean(value, "supportsResponses"),
    supportsStreaming: requiredBoolean(value, "supportsStreaming"),
    supportsWarmImport: requiredBoolean(value, "supportsWarmImport"),
    credentialMobility: readEnum(value.credentialMobility, `${context}.credentialMobility`, ["local_only", "descriptor_only", "importable", "non_exportable"] as const),
    credentialOrigin: requiredString(value, "credentialOrigin"),
    lastHealthyAt: optionalIsoTimestamp(value, "lastHealthyAt"),
    lastFailureAt: optionalIsoTimestamp(value, "lastFailureAt"),
    failureClass: optionalString(value, "failureClass"),
    topologyTargets: topologyTargetsValue.map((entry, index) => parseExecutionTarget(entry, `${context}.topologyTargets[${index}]`)),
  };
}

function parseNodeHealthSummary(value: unknown, context: string): BridgeNodeHealthSummary {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return {
    groupId: requiredString(value, "groupId"),
    nodeId: requiredString(value, "nodeId"),
    reachable: requiredBoolean(value, "reachable"),
    lastHealthyAt: optionalIsoTimestamp(value, "lastHealthyAt"),
    lastFailureAt: optionalIsoTimestamp(value, "lastFailureAt"),
    failureClass: optionalString(value, "failureClass"),
  };
}

function parseHealthReportPayload(value: unknown): BridgeHealthReportPayload {
  if (!isRecord(value)) {
    throw new Error("bridge message health must be an object");
  }
  const nodesValue = value.nodes;
  if (!Array.isArray(nodesValue)) {
    throw new Error("bridge message health.nodes must be an array");
  }
  return {
    processHealthy: requiredBoolean(value, "processHealthy"),
    upstreamHealthy: requiredBoolean(value, "upstreamHealthy"),
    availableAccountCount: requiredNonNegativeInteger(value, "availableAccountCount"),
    localOauthBootstrapReady: requiredBoolean(value, "localOauthBootstrapReady"),
    queuedRequests: optionalNonNegativeInteger(value, "queuedRequests"),
    nodes: nodesValue.map((entry, index) => parseNodeHealthSummary(entry, `health.nodes[${index}]`)),
  };
}

function parseRequestContext(value: unknown): BridgeRequestContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bridge message requestContext must be an object when present");
  }
  return {
    tenantId: optionalString(value, "tenantId"),
    issuer: optionalString(value, "issuer"),
    keyId: optionalString(value, "keyId"),
  };
}

function parseRoutingIntent(value: unknown): BridgeRoutingIntent | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bridge message routingIntent must be an object when present");
  }
  return {
    providerId: optionalString(value, "providerId"),
    model: optionalString(value, "model"),
    accountId: optionalString(value, "accountId"),
  };
}

function parseUsageSummary(value: unknown): BridgeUsageSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("bridge message usage must be an object when present");
  }
  return {
    requestCount: optionalNonNegativeInteger(value, "requestCount"),
    promptTokens: optionalNonNegativeInteger(value, "promptTokens"),
    completionTokens: optionalNonNegativeInteger(value, "completionTokens"),
    totalTokens: optionalNonNegativeInteger(value, "totalTokens"),
  };
}

function parseBaseEnvelope(record: Record<string, unknown>): BridgeBaseEnvelope {
  const type = requiredString(record, "type");
  const protocolVersion = readEnum(record.protocolVersion, "protocolVersion", [BRIDGE_PROTOCOL_VERSION] as const);
  return {
    type,
    protocolVersion,
    sessionId: optionalString(record, "sessionId"),
    streamId: optionalString(record, "streamId"),
    sentAt: requiredIsoTimestamp(record, "sentAt"),
    traceId: requiredString(record, "traceId"),
    ownerSubject: requiredString(record, "ownerSubject"),
    clusterId: requiredString(record, "clusterId"),
    agentId: requiredString(record, "agentId"),
    groupId: optionalString(record, "groupId"),
    nodeId: optionalString(record, "nodeId"),
  };
}

export function parseBridgeMessage(value: unknown): BridgeMessage {
  if (!isRecord(value)) {
    throw new Error("bridge message must be an object");
  }

  const base = parseBaseEnvelope(value);
  switch (base.type) {
    case "hello":
      return {
        ...base,
        type: "hello",
        peerDid: requiredString(value, "peerDid"),
        environment: requiredString(value, "environment"),
        bridgeAgentVersion: requiredString(value, "bridgeAgentVersion"),
        authMode: readEnum(value.authMode, "authMode", ["admin_key", "at_did", "did_signed_challenge"] as const),
        capabilitiesHash: optionalString(value, "capabilitiesHash"),
        labels: optionalStringArray(value, "labels"),
        topology: parseTopologySummary(value.topology),
      };
    case "hello_ack":
      return {
        ...base,
        type: "hello_ack",
        sessionId: requiredString(value, "sessionId"),
        heartbeatIntervalMs: requiredNonNegativeInteger(value, "heartbeatIntervalMs"),
        maxConcurrentStreams: requiredNonNegativeInteger(value, "maxConcurrentStreams"),
        maxFrameBytes: requiredNonNegativeInteger(value, "maxFrameBytes"),
        resumeToken: optionalString(value, "resumeToken"),
      };
    case "heartbeat":
      return {
        ...base,
        type: "heartbeat",
        sequence: requiredNonNegativeInteger(value, "sequence"),
        activeStreams: optionalNonNegativeInteger(value, "activeStreams"),
        queuedRequests: optionalNonNegativeInteger(value, "queuedRequests"),
      };
    case "capabilities": {
      const capabilitiesValue = value.capabilities;
      if (!Array.isArray(capabilitiesValue)) {
        throw new Error("bridge message capabilities must be an array");
      }
      return {
        ...base,
        type: "capabilities",
        capabilities: capabilitiesValue.map((entry, index) => parseCapabilityAdvertisement(entry, `capabilities[${index}]`)),
      };
    }
    case "health_report":
      return {
        ...base,
        type: "health_report",
        health: parseHealthReportPayload(value.health),
      };
    case "request_open":
      return {
        ...base,
        type: "request_open",
        streamId: requiredString(value, "streamId"),
        method: requiredString(value, "method"),
        path: requiredString(value, "path"),
        headers: requiredStringRecord(value, "headers"),
        requestContext: parseRequestContext(value.requestContext),
        routingIntent: parseRoutingIntent(value.routingIntent),
        originClusterId: optionalString(value, "originClusterId"),
        originNodeId: optionalString(value, "originNodeId"),
        hopCount: requiredNonNegativeInteger(value, "hopCount"),
      };
    case "request_chunk":
      return {
        ...base,
        type: "request_chunk",
        streamId: requiredString(value, "streamId"),
        chunk: requiredString(value, "chunk"),
        encoding: readEnum(value.encoding, "encoding", ["utf8", "base64"] as const),
        final: value.final === undefined ? false : requiredBoolean(value, "final"),
      };
    case "response_head":
      return {
        ...base,
        type: "response_head",
        streamId: requiredString(value, "streamId"),
        status: requiredNonNegativeInteger(value, "status"),
        headers: requiredStringRecord(value, "headers"),
        servedByClusterId: optionalString(value, "servedByClusterId"),
        servedByGroupId: optionalString(value, "servedByGroupId"),
        servedByNodeId: optionalString(value, "servedByNodeId"),
        providerId: optionalString(value, "providerId"),
        accountId: optionalString(value, "accountId"),
      };
    case "response_chunk":
      return {
        ...base,
        type: "response_chunk",
        streamId: requiredString(value, "streamId"),
        chunk: requiredString(value, "chunk"),
        encoding: readEnum(value.encoding, "encoding", ["utf8", "base64"] as const),
        final: value.final === undefined ? false : requiredBoolean(value, "final"),
        servedByClusterId: optionalString(value, "servedByClusterId"),
        servedByGroupId: optionalString(value, "servedByGroupId"),
        servedByNodeId: optionalString(value, "servedByNodeId"),
        providerId: optionalString(value, "providerId"),
        accountId: optionalString(value, "accountId"),
      };
    case "response_end":
      return {
        ...base,
        type: "response_end",
        streamId: requiredString(value, "streamId"),
        usage: parseUsageSummary(value.usage),
        servedByClusterId: optionalString(value, "servedByClusterId"),
        servedByGroupId: optionalString(value, "servedByGroupId"),
        servedByNodeId: optionalString(value, "servedByNodeId"),
        providerId: optionalString(value, "providerId"),
        accountId: optionalString(value, "accountId"),
      };
    case "error":
      return {
        ...base,
        type: "error",
        streamId: optionalString(value, "streamId"),
        code: requiredString(value, "code"),
        message: requiredString(value, "message"),
        retryable: requiredBoolean(value, "retryable"),
      };
    default:
      throw new Error(`unsupported bridge message type: ${base.type}`);
  }
}

export function parseBridgeMessageJson(jsonText: string): BridgeMessage {
  const parsed: unknown = JSON.parse(jsonText);
  return parseBridgeMessage(parsed);
}
