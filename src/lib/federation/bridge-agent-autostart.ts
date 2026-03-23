import type { CredentialStoreLike } from "../credential-store.js";
import type { ProxyConfig } from "../config.js";
import type { KeyPool } from "../key-pool.js";
import { toOpenAiModel } from "../models.js";
import { createFederationBridgeAgent, type FederationBridgeAgent } from "./bridge-agent.js";
import type {
  BridgeCapabilityAdvertisement,
  BridgeDefaultExecutionPolicy,
  BridgeHealthReportPayload,
  BridgeTopologySummary,
} from "./bridge-protocol.js";

interface LoggerLike {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
}

interface FederationBridgeAutostartDeps {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly credentialStore: CredentialStoreLike;
  readonly logger: LoggerLike;
  readonly getResolvedModelCatalog?: () => Promise<{ readonly modelIds: readonly string[] }>;
  readonly handleBridgeRequest?: (input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
    readonly ownerSubject: string;
  }) => Promise<{
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly encoding?: "utf8" | "base64";
  }>;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseDefaultExecutionPolicy(value: string | undefined): BridgeDefaultExecutionPolicy {
  switch ((value ?? "node_affinity").trim().toLowerCase()) {
    case "cluster_default":
    case "cluster":
      return "cluster_default";
    case "group_affinity":
    case "group":
      return "group_affinity";
    case "node_affinity":
    case "node":
    default:
      return "node_affinity";
  }
}

function buildTopologyFromEnv(env: NodeJS.ProcessEnv): BridgeTopologySummary | undefined {
  const clusterId = env.FEDERATION_SELF_CLUSTER_ID?.trim();
  const groupId = env.FEDERATION_SELF_GROUP_ID?.trim();
  const nodeId = env.FEDERATION_SELF_NODE_ID?.trim();
  if (!clusterId && !groupId && !nodeId) {
    return undefined;
  }

  const nodeLabels = parseCsvEnv(env.FEDERATION_BRIDGE_NODE_LABELS);
  return {
    groups: groupId && nodeId ? [{ groupId, nodeIds: [nodeId] }] : [],
    nodes: groupId && nodeId ? [{ groupId, nodeId, labels: nodeLabels }] : [],
    defaultExecutionPolicy: parseDefaultExecutionPolicy(env.FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY),
  };
}

function capabilityPrefixesForProvider(providerId: string, config: ProxyConfig): readonly string[] {
  if (providerId === config.openaiProviderId) {
    return uniqueStrings([...config.responsesModelPrefixes, ...config.openaiModelPrefixes]);
  }
  if (providerId === "factory") {
    return uniqueStrings([...config.factoryModelPrefixes]);
  }
  if (providerId === "ollama" || providerId === "ollama-cloud") {
    return uniqueStrings([...config.ollamaModelPrefixes]);
  }
  return [];
}

async function buildCapabilities(
  config: ProxyConfig,
  keyPool: KeyPool,
  credentialStore: CredentialStoreLike,
  getResolvedModelCatalog?: () => Promise<{ readonly modelIds: readonly string[] }>,
): Promise<readonly BridgeCapabilityAdvertisement[]> {
  const [providers, statuses] = await Promise.all([
    credentialStore.listProviders(false).catch(() => []),
    keyPool.getAllStatuses().catch(() => ({} as Awaited<ReturnType<KeyPool["getAllStatuses"]>>)),
  ]);

  const groupId = process.env.FEDERATION_SELF_GROUP_ID?.trim();
  const nodeId = process.env.FEDERATION_SELF_NODE_ID?.trim();
  const topologyTargets = groupId && nodeId ? [{ groupId, nodeId }] : [];
  const resolvedModelCatalog = getResolvedModelCatalog ? await getResolvedModelCatalog().catch(() => ({ modelIds: [] })) : { modelIds: [] };

  return providers.map((provider) => {
    const providerStatus = statuses[provider.id];
    const modelPrefixes = capabilityPrefixesForProvider(provider.id, config);
    const models = modelPrefixes.length > 0
      ? resolvedModelCatalog.modelIds.filter((modelId) => modelPrefixes.some((prefix) => modelId.startsWith(prefix.replace(/[:/]$/u, ""))))
      : [];
    return {
      providerId: provider.id,
      modelPrefixes,
      models,
      authType: provider.authType,
      accountCount: provider.accountCount,
      availableAccountCount: providerStatus?.availableAccounts ?? provider.accountCount,
      supportsModelsList: true,
      supportsChatCompletions: true,
      supportsResponses: true,
      supportsStreaming: true,
      supportsWarmImport: false,
      credentialMobility: provider.authType === "oauth_bearer" ? "non_exportable" : "importable",
      credentialOrigin: provider.authType === "oauth_bearer" ? "localhost_oauth" : "local_api_key",
      lastHealthyAt: provider.accountCount > 0 ? new Date().toISOString() : undefined,
      topologyTargets,
    };
  });
}

async function buildHealth(keyPool: KeyPool, credentialStore: CredentialStoreLike): Promise<BridgeHealthReportPayload> {
  const [providers, statuses] = await Promise.all([
    credentialStore.listProviders(false).catch(() => []),
    keyPool.getAllStatuses().catch(() => ({} as Awaited<ReturnType<KeyPool["getAllStatuses"]>>)),
  ]);

  const groupId = process.env.FEDERATION_SELF_GROUP_ID?.trim();
  const nodeId = process.env.FEDERATION_SELF_NODE_ID?.trim();
  const availableAccountCount = Object.values(statuses).reduce((sum, status) => sum + status.availableAccounts, 0);
  const localOauthBootstrapReady = providers.some((provider) => provider.authType === "oauth_bearer" && provider.accountCount > 0);

  return {
    processHealthy: true,
    upstreamHealthy: availableAccountCount > 0 || providers.length > 0,
    availableAccountCount,
    localOauthBootstrapReady,
    queuedRequests: 0,
    nodes: groupId && nodeId
      ? [{
          groupId,
          nodeId,
          reachable: true,
          lastHealthyAt: new Date().toISOString(),
        }]
      : [],
  };
}

export function createEnvFederationBridgeAgent(deps: FederationBridgeAutostartDeps): FederationBridgeAgent | undefined {
  const relayUrl = process.env.FEDERATION_BRIDGE_RELAY_URL?.trim();
  if (!relayUrl) {
    return undefined;
  }

  const ownerSubject = process.env.FEDERATION_BRIDGE_OWNER_SUBJECT?.trim()
    || process.env.FEDERATION_DEFAULT_OWNER_SUBJECT?.trim();
  const peerDid = process.env.FEDERATION_SELF_PEER_DID?.trim();
  const clusterId = process.env.FEDERATION_SELF_CLUSTER_ID?.trim();
  const agentId = process.env.FEDERATION_BRIDGE_AGENT_ID?.trim();

  const missing = [
    ownerSubject ? undefined : "FEDERATION_BRIDGE_OWNER_SUBJECT or FEDERATION_DEFAULT_OWNER_SUBJECT",
    peerDid ? undefined : "FEDERATION_SELF_PEER_DID",
    clusterId ? undefined : "FEDERATION_SELF_CLUSTER_ID",
    agentId ? undefined : "FEDERATION_BRIDGE_AGENT_ID",
  ].filter((entry): entry is string => typeof entry === "string");

  if (missing.length > 0) {
    deps.logger.warn({ relayUrl, missing }, "bridge relay autostart skipped because required federation bridge env is missing");
    return undefined;
  }

  const normalizedOwnerSubject = ownerSubject!;
  const normalizedPeerDid = peerDid!;
  const normalizedClusterId = clusterId!;
  const normalizedAgentId = agentId!;

  const rawAuthToken = process.env.FEDERATION_BRIDGE_AUTH_TOKEN?.trim();
  const authorization = rawAuthToken && rawAuthToken.length > 0 ? `Bearer ${rawAuthToken}` : undefined;
  const authModeRaw = (process.env.FEDERATION_BRIDGE_AUTH_MODE ?? "admin_key").trim().toLowerCase();
  const authMode = authModeRaw === "at_did" || authModeRaw === "did_signed_challenge"
    ? authModeRaw
    : "admin_key";

  const labels = uniqueStrings(parseCsvEnv(process.env.FEDERATION_BRIDGE_LABELS));
  const topology = buildTopologyFromEnv(process.env);
  const reconnectMinMs = Number.parseInt(process.env.FEDERATION_BRIDGE_RECONNECT_MIN_MS ?? "", 10);
  const reconnectMaxMs = Number.parseInt(process.env.FEDERATION_BRIDGE_RECONNECT_MAX_MS ?? "", 10);

  return createFederationBridgeAgent({
    relayUrl,
    authorization,
    ownerSubject: normalizedOwnerSubject,
    peerDid: normalizedPeerDid,
    clusterId: normalizedClusterId,
    agentId: normalizedAgentId,
    environment: process.env.FEDERATION_BRIDGE_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || "local",
    bridgeAgentVersion: process.env.FEDERATION_BRIDGE_AGENT_VERSION?.trim() || "0.1.0",
    authMode,
    labels,
    topology,
    reconnectMinMs: Number.isFinite(reconnectMinMs) && reconnectMinMs > 0 ? reconnectMinMs : undefined,
    reconnectMaxMs: Number.isFinite(reconnectMaxMs) && reconnectMaxMs > 0 ? reconnectMaxMs : undefined,
    getCapabilities: () => buildCapabilities(deps.config, deps.keyPool, deps.credentialStore, deps.getResolvedModelCatalog),
    getHealth: () => buildHealth(deps.keyPool, deps.credentialStore),
    handleRequest: async ({ request, bodyText }) => {
      if (request.method === "GET" && request.path === "/v1/models") {
        const modelCatalog = deps.getResolvedModelCatalog
          ? await deps.getResolvedModelCatalog()
          : { modelIds: [] };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            object: "list",
            data: modelCatalog.modelIds.map(toOpenAiModel),
          }),
        };
      }

      if (deps.handleBridgeRequest) {
        return deps.handleBridgeRequest({
          method: request.method,
          path: request.path,
          headers: request.headers,
          bodyText,
          ownerSubject: request.ownerSubject,
        });
      }

      return {
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: `bridge route not supported: ${request.method} ${request.path}` }),
      };
    },
  });
}
