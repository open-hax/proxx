import type { FastifyInstance } from "fastify";
import type { FederationBridgeRelay } from "../../lib/federation/bridge-relay.js";

import {
  authCanManageFederation,
  getResolvedAuth,
  parseOptionalPositiveInteger,
} from "../shared/ui-auth.js";
import type { UiRouteDependencies } from "../types.js";
import {
  normalizeTenantProviderKind,
  normalizeTenantProviderShareMode,
  normalizeTenantProviderTrustTier,
} from "../../lib/tenant-provider-policy.js";
import {
  buildFederationAccountKnowledge,
  type FederationCredentialExport,
  findCredentialForFederationExport,
} from "./account-knowledge.js";
import { parseBridgeLeaseAccounts, parseBridgeLeaseExport, type BridgeLeaseAccountSummary } from "./bridge-lease-parsers.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  projectedAccountAllowsCredentialImport,
} from "./remote.js";
import { resolveFederationRoutePath, type FederationRouteOptions } from "./prefix.js";
import { shouldWarmImportProjectedAccount } from "../../lib/db/sql-federation-store.js";
import type { RequestLogEntry } from "../../lib/request-log-store.js";

export interface FederationUiRouteContext {
  readonly bridgeRelay?: FederationBridgeRelay;
  readonly federationRequestTimeoutMs?: number;
}

function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }

  return fallback;
}

function sanitizeFederationUsageEntry(candidate: unknown): RequestLogEntry | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }

  const row = candidate as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const providerId = typeof row.providerId === "string" ? row.providerId.trim() : "";
  const accountId = typeof row.accountId === "string" ? row.accountId.trim() : "";
  const authType = row.authType;
  const model = typeof row.model === "string" ? row.model.trim() : "";
  const upstreamMode = typeof row.upstreamMode === "string" ? row.upstreamMode.trim() : "";
  const upstreamPath = typeof row.upstreamPath === "string" ? row.upstreamPath.trim() : "";
  const timestamp = typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : undefined;
  const status = typeof row.status === "number" && Number.isFinite(row.status) ? row.status : undefined;
  const latencyMs = typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs) ? row.latencyMs : undefined;
  const serviceTierSource = row.serviceTierSource;

  if (!id || !providerId || !accountId || !model || !upstreamMode || !upstreamPath || timestamp === undefined || status === undefined || latencyMs === undefined) {
    return undefined;
  }

  const normalizedAuthType: RequestLogEntry["authType"] =
    authType === "api_key" || authType === "oauth_bearer" || authType === "local" || authType === "none"
      ? authType
      : "none";

  const normalizedRouteKind: RequestLogEntry["routeKind"] =
    row.routeKind === "local" || row.routeKind === "federated" || row.routeKind === "bridge"
      ? row.routeKind
      : "local";

  const normalizedServiceTierSource: RequestLogEntry["serviceTierSource"] =
    serviceTierSource === "fast_mode" || serviceTierSource === "explicit" || serviceTierSource === "none"
      ? serviceTierSource
      : "none";

  return {
    id,
    timestamp,
    tenantId: typeof row.tenantId === "string" ? row.tenantId : undefined,
    issuer: typeof row.issuer === "string" ? row.issuer : undefined,
    keyId: typeof row.keyId === "string" ? row.keyId : undefined,
    routeKind: normalizedRouteKind,
    federationOwnerSubject: typeof row.federationOwnerSubject === "string" ? row.federationOwnerSubject : undefined,
    routedPeerId: typeof row.routedPeerId === "string" ? row.routedPeerId : undefined,
    routedPeerLabel: typeof row.routedPeerLabel === "string" ? row.routedPeerLabel : undefined,
    providerId,
    accountId,
    authType: normalizedAuthType,
    model,
    upstreamMode,
    upstreamPath,
    status,
    latencyMs,
    serviceTier: typeof row.serviceTier === "string" ? row.serviceTier : undefined,
    serviceTierSource: normalizedServiceTierSource,
    promptTokens: typeof row.promptTokens === "number" && Number.isFinite(row.promptTokens) ? row.promptTokens : undefined,
    completionTokens: typeof row.completionTokens === "number" && Number.isFinite(row.completionTokens) ? row.completionTokens : undefined,
    totalTokens: typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens) ? row.totalTokens : undefined,
    cachedPromptTokens: typeof row.cachedPromptTokens === "number" && Number.isFinite(row.cachedPromptTokens) ? row.cachedPromptTokens : undefined,
    imageCount: typeof row.imageCount === "number" && Number.isFinite(row.imageCount) ? row.imageCount : undefined,
    imageCostUsd: typeof row.imageCostUsd === "number" && Number.isFinite(row.imageCostUsd) ? row.imageCostUsd : undefined,
    promptCacheKeyHash: typeof row.promptCacheKeyHash === "string" ? row.promptCacheKeyHash : undefined,
    promptCacheKeyUsed: row.promptCacheKeyUsed === true,
    cacheHit: row.cacheHit === true,
    ttftMs: typeof row.ttftMs === "number" && Number.isFinite(row.ttftMs) ? row.ttftMs : undefined,
    tps: typeof row.tps === "number" && Number.isFinite(row.tps) ? row.tps : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    upstreamErrorCode: typeof row.upstreamErrorCode === "string" ? row.upstreamErrorCode : undefined,
    upstreamErrorType: typeof row.upstreamErrorType === "string" ? row.upstreamErrorType : undefined,
    upstreamErrorMessage: typeof row.upstreamErrorMessage === "string" ? row.upstreamErrorMessage : undefined,
    costUsd: typeof row.costUsd === "number" && Number.isFinite(row.costUsd) ? row.costUsd : undefined,
    energyJoules: typeof row.energyJoules === "number" && Number.isFinite(row.energyJoules) ? row.energyJoules : undefined,
    waterEvaporatedMl: typeof row.waterEvaporatedMl === "number" && Number.isFinite(row.waterEvaporatedMl) ? row.waterEvaporatedMl : undefined,
  };
}

export async function registerFederationUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  context: FederationUiRouteContext = {},
  options?: FederationRouteOptions,
): Promise<void> {
  app.get<{
    Querystring: { readonly ownerSubject?: string };
  }>(resolveFederationRoutePath("/federation/peers", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const peers = await deps.sqlFederationStore.listPeers(ownerSubject);
    reply.send({ peers });
  });

  app.get(resolveFederationRoutePath("/federation/self", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const peerCount = deps.sqlFederationStore
      ? (await deps.sqlFederationStore.listPeers()).length
      : 0;

    reply.send({
      nodeId: process.env.FEDERATION_SELF_NODE_ID ?? null,
      groupId: process.env.FEDERATION_SELF_GROUP_ID ?? null,
      clusterId: process.env.FEDERATION_SELF_CLUSTER_ID ?? null,
      peerDid: process.env.FEDERATION_SELF_PEER_DID ?? null,
      publicBaseUrl: process.env.FEDERATION_SELF_PUBLIC_BASE_URL ?? null,
      peerCount,
    });
  });

  app.post<{
    Body: {
      readonly id?: string;
      readonly ownerCredential?: string;
      readonly peerDid?: string;
      readonly label?: string;
      readonly baseUrl?: string;
      readonly controlBaseUrl?: string;
      readonly auth?: Record<string, unknown>;
      readonly capabilities?: Record<string, unknown>;
      readonly status?: string;
    };
  }>(resolveFederationRoutePath("/federation/peers", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerCredential = typeof request.body?.ownerCredential === "string" ? request.body.ownerCredential.trim() : "";
    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    const baseUrl = typeof request.body?.baseUrl === "string" ? request.body.baseUrl.trim() : "";

    if (!ownerCredential || !label || !baseUrl) {
      reply.code(400).send({ error: "owner_credential_label_and_base_url_required" });
      return;
    }

    const peer = await deps.sqlFederationStore.upsertPeer({
      id: request.body?.id,
      ownerCredential,
      peerDid: request.body?.peerDid,
      label,
      baseUrl,
      controlBaseUrl: request.body?.controlBaseUrl,
      auth: request.body?.auth,
      capabilities: request.body?.capabilities,
      status: request.body?.status,
    });
    await deps.sqlFederationStore.appendDiffEvent({
      ownerSubject: peer.ownerSubject,
      entityType: "peer",
      entityKey: peer.id,
      op: "upsert",
      payload: {
        peerDid: peer.peerDid,
        label: peer.label,
        baseUrl: peer.baseUrl,
        controlBaseUrl: peer.controlBaseUrl,
        authMode: peer.authMode,
        status: peer.status,
      },
    });

    reply.code(201).send({ peer });
  });

  app.get(resolveFederationRoutePath("/federation/bridge/ws", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    reply.code(426).header("upgrade", "websocket").send({ error: "websocket_upgrade_required" });
  });

  app.get(resolveFederationRoutePath("/federation/observability/ws", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    reply.code(426).header("upgrade", "websocket").send({ error: "websocket_upgrade_required" });
  });

  app.get(resolveFederationRoutePath("/federation/bridges", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const bridgeRelay = context.bridgeRelay;
    if (!bridgeRelay) {
      reply.code(503).send({ error: "federation_bridge_not_supported" });
      return;
    }

    const isGlobalAdmin = auth?.kind === "legacy_admin";
    const allSessions = bridgeRelay.listSessions();
    const sessions = isGlobalAdmin
      ? allSessions
      : allSessions.filter((session) => session.tenantId === auth?.tenantId);

    reply.send({ sessions });
  });

  app.post<{
    Body: {
      readonly sessionId?: string;
      readonly agentId?: string;
      readonly providerId?: string;
      readonly limit?: number;
      readonly refreshBufferMs?: number;
      readonly forceApiKeys?: boolean;
    };
  }>(resolveFederationRoutePath("/federation/bridges/lease/import", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!authCanManageFederation(auth)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    const bridgeRelay = context.bridgeRelay;
    if (!bridgeRelay) {
      reply.code(503).send({ error: "federation_bridge_not_supported" });
      return;
    }

    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    if (!providerId) {
      reply.code(400).send({ error: "provider_id_required" });
      return;
    }

    const limit = typeof request.body?.limit === "number" && Number.isFinite(request.body.limit)
      ? Math.max(1, Math.min(Math.floor(request.body.limit), 5000))
      : undefined;
    const refreshBufferMs = typeof request.body?.refreshBufferMs === "number" && Number.isFinite(request.body.refreshBufferMs)
      ? Math.max(0, Math.floor(request.body.refreshBufferMs))
      : 10 * 60_000;
    const forceApiKeys = request.body?.forceApiKeys === true;

    const requestedSessionId = typeof request.body?.sessionId === "string" ? request.body.sessionId.trim() : "";
    const requestedAgentId = typeof request.body?.agentId === "string" ? request.body.agentId.trim() : "";

    const isGlobalAdmin = auth.kind === "legacy_admin";
    const allSessions = bridgeRelay.listSessions();
    const visibleSessions = isGlobalAdmin
      ? allSessions
      : allSessions.filter((session) => session.tenantId === auth.tenantId);

    const session = requestedSessionId
      ? visibleSessions.find((candidate) => candidate.sessionId === requestedSessionId)
      : requestedAgentId
        ? visibleSessions.find((candidate) => candidate.agentId === requestedAgentId)
        : undefined;

    if (!session || session.state !== "connected") {
      reply.code(404).send({ error: "bridge_session_not_found_or_not_connected" });
      return;
    }

    if (!deps.credentialStore) {
      reply.code(503).send({ error: "credential_store_not_supported" });
      return;
    }

    const listPath = `/api/bridge/credentials/accounts?providerId=${encodeURIComponent(providerId)}${limit ? `&limit=${limit}` : ""}`;
    let remoteAccounts: BridgeLeaseAccountSummary[] = [];

    try {
      const remoteList = await bridgeRelay.requestJson(session.sessionId, {
        method: "GET",
        path: listPath,
        timeoutMs: 20_000,
        headers: { accept: "application/json" },
      });
      if (remoteList.status < 200 || remoteList.status >= 300) {
        reply.code(502).send({ error: "bridge_accounts_list_failed", status: remoteList.status });
        return;
      }

      remoteAccounts = parseBridgeLeaseAccounts(remoteList.json, providerId);
    } catch (error) {
      reply.code(502).send({ error: "bridge_accounts_list_failed", detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    const localProviders = await deps.credentialStore.listProviders(false).catch(() => []);
    const localProvider = localProviders.find((candidate) => candidate.id === providerId);
    const localExpiresByAccountId = new Map<string, number | undefined>();
    const localHasAccount = new Set<string>();
    for (const account of localProvider?.accounts ?? []) {
      localHasAccount.add(account.id);
      localExpiresByAccountId.set(account.id, account.expiresAt);
    }

    const now = Date.now();
    const toImport = remoteAccounts.filter((account) => {
      if (account.authType === "api_key") {
        return forceApiKeys || !localHasAccount.has(account.accountId);
      }

      const localExpiresAt = localExpiresByAccountId.get(account.accountId);
      if (!localHasAccount.has(account.accountId)) {
        return true;
      }
      if (typeof localExpiresAt !== "number" || !Number.isFinite(localExpiresAt)) {
        return true;
      }
      return localExpiresAt <= now + refreshBufferMs;
    });

    const errors: string[] = [];
    let imported = 0;
    let refreshed = 0;
    const skipped = remoteAccounts.length - toImport.length;

    const exportPath = "/api/bridge/credentials/export";
    const concurrency = 6;
    const queue = [...toImport];

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
      while (queue.length > 0) {
        const account = queue.shift();
        if (!account) {
          return;
        }

        try {
          const remoteExport = await bridgeRelay.requestJson(session.sessionId, {
            method: "POST",
            path: exportPath,
            timeoutMs: 30_000,
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ providerId, accountId: account.accountId }),
          });

          if (remoteExport.status < 200 || remoteExport.status >= 300) {
            errors.push(`${account.accountId}: export_status_${remoteExport.status}`);
            continue;
          }

          const exported = parseBridgeLeaseExport(remoteExport.json);
          if (!exported) {
            errors.push(`${account.accountId}: export_invalid_payload`);
            continue;
          }

          const existed = localHasAccount.has(account.accountId);

          if (exported.authType === "oauth_bearer") {
            await deps.credentialStore.upsertOAuthAccount(
              providerId,
              account.accountId,
              exported.secret,
              undefined,
              exported.expiresAt,
              exported.chatgptAccountId,
              exported.email,
              exported.subject,
              exported.planType,
            );
          } else {
            await deps.credentialStore.upsertApiKeyAccount(providerId, account.accountId, exported.secret);
          }

          if (existed) {
            refreshed += 1;
          } else {
            imported += 1;
            localHasAccount.add(account.accountId);
          }
        } catch (error) {
          errors.push(`${account.accountId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    await Promise.all(workers);

    await deps.keyPool.warmup().catch(() => undefined);

    reply.send({
      sessionId: session.sessionId,
      agentId: session.agentId,
      providerId,
      remoteAccountCount: remoteAccounts.length,
      plannedImportCount: toImport.length,
      imported,
      refreshed,
      skipped,
      failed: errors.length,
      errors: errors.slice(0, 10),
    });
  });

  app.get<{ Params: { readonly sessionId: string } }>(resolveFederationRoutePath("/federation/bridges/:sessionId", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const bridgeRelay = context.bridgeRelay;
    if (!bridgeRelay) {
      reply.code(503).send({ error: "federation_bridge_not_supported" });
      return;
    }

    const session = bridgeRelay.getSession(request.params.sessionId);
    if (!session) {
      reply.code(404).send({ error: "bridge_session_not_found" });
      return;
    }

    const isGlobalAdmin = auth?.kind === "legacy_admin";
    if (!isGlobalAdmin && session.tenantId !== auth?.tenantId) {
      reply.code(404).send({ error: "bridge_session_not_found" });
      return;
    }

    reply.send({ session });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string; readonly afterSeq?: string; readonly limit?: string };
  }>(resolveFederationRoutePath("/federation/diff-events", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" ? request.query.ownerSubject.trim() : "";
    if (!ownerSubject) {
      reply.code(400).send({ error: "owner_subject_required" });
      return;
    }

    const afterSeq = typeof request.query.afterSeq === "string" ? Number.parseInt(request.query.afterSeq, 10) : undefined;
    const limit = toSafeLimit(request.query.limit, 200, 500);
    const events = await deps.sqlFederationStore.listDiffEvents({ ownerSubject, afterSeq, limit });
    reply.send({ ownerSubject, events });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string };
  }>(resolveFederationRoutePath("/federation/accounts", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const projectedAccounts = await deps.sqlFederationStore.listProjectedAccounts(ownerSubject);
    const { localAccounts, knownAccounts } = await buildFederationAccountKnowledge(deps.credentialStore, projectedAccounts, {
      ownerSubject,
      defaultOwnerSubject: process.env.FEDERATION_DEFAULT_OWNER_SUBJECT,
    });

    reply.send({
      ownerSubject: ownerSubject ?? null,
      localAccounts,
      projectedAccounts,
      knownAccounts,
    });
  });

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>(resolveFederationRoutePath("/federation/accounts/export", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!providerId || !accountId) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    let account = await findCredentialForFederationExport(deps.credentialStore, providerId, accountId);
    if (!account) {
      reply.code(404).send({ error: "credential_account_not_found" });
      return;
    }

    if (account.authType === "oauth_bearer") {
      // OAuth refresh tokens never leave the minting node, but access tokens may be leased.
      // If this node is the authority and the token is expiring, refresh before exporting so
      // peers receive a usable lease.
      const now = Date.now();
      const needsRefresh = typeof account.expiresAt === "number"
        && Number.isFinite(account.expiresAt)
        && account.expiresAt <= now + 60_000;
      const hasRefreshToken = typeof account.refreshToken === "string" && account.refreshToken.trim().length > 0;
      const providerMatchesOpenAi = account.providerId.trim().toLowerCase() === deps.config.openaiProviderId.trim().toLowerCase();

      if (needsRefresh && hasRefreshToken && providerMatchesOpenAi && deps.refreshOpenAiOauthAccounts) {
        await deps.refreshOpenAiOauthAccounts(account.accountId).catch(() => undefined);
        const refreshed = await findCredentialForFederationExport(deps.credentialStore, providerId, accountId);
        if (refreshed) {
          account = refreshed;
        }
      }

      reply.send({ account: { ...account, refreshToken: undefined } });
      return;
    }

    reply.send({ account });
  });

  app.post<{
    Body: {
      readonly accounts?: ReadonlyArray<{
        readonly sourcePeerId?: string;
        readonly ownerSubject?: string;
        readonly providerId?: string;
        readonly accountId?: string;
        readonly accountSubject?: string;
        readonly chatgptAccountId?: string;
        readonly email?: string;
        readonly planType?: string;
        readonly availabilityState?: "descriptor" | "remote_route" | "imported";
        readonly metadata?: Record<string, unknown>;
      }>;
    };
  }>(resolveFederationRoutePath("/federation/projected-accounts/import", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const accounts = Array.isArray(request.body?.accounts) ? request.body.accounts : [];
    if (accounts.length === 0) {
      reply.code(400).send({ error: "accounts_required" });
      return;
    }

    const imported = [] as Awaited<ReturnType<typeof deps.sqlFederationStore.upsertProjectedAccount>>[];
    for (const account of accounts) {
      const sourcePeerId = typeof account?.sourcePeerId === "string" ? account.sourcePeerId.trim() : "";
      const ownerSubject = typeof account?.ownerSubject === "string" ? account.ownerSubject.trim() : "";
      const providerId = typeof account?.providerId === "string" ? account.providerId.trim() : "";
      const accountId = typeof account?.accountId === "string" ? account.accountId.trim() : "";
      if (!sourcePeerId || !ownerSubject || !providerId || !accountId) {
        reply.code(400).send({ error: "source_peer_id_owner_subject_provider_id_and_account_id_required" });
        return;
      }

      const record = await deps.sqlFederationStore.upsertProjectedAccount({
        sourcePeerId,
        ownerSubject,
        providerId,
        accountId,
        accountSubject: typeof account?.accountSubject === "string" ? account.accountSubject : undefined,
        chatgptAccountId: typeof account?.chatgptAccountId === "string" ? account.chatgptAccountId : undefined,
        email: typeof account?.email === "string" ? account.email : undefined,
        planType: typeof account?.planType === "string" ? account.planType : undefined,
        availabilityState: account?.availabilityState,
        metadata: account?.metadata,
      });
      imported.push(record);
      await deps.sqlFederationStore.appendDiffEvent({
        ownerSubject: record.ownerSubject,
        entityType: "projected_account",
        entityKey: `${record.sourcePeerId}:${record.providerId}:${record.accountId}`,
        op: "upsert",
        payload: {
          providerId: record.providerId,
          accountId: record.accountId,
          availabilityState: record.availabilityState,
          sourcePeerId: record.sourcePeerId,
          email: record.email,
          chatgptAccountId: record.chatgptAccountId,
        },
      });
    }

    reply.code(201).send({ accounts: imported });
  });

  app.post<{
    Body: { readonly sourcePeerId?: string; readonly providerId?: string };
  }>(resolveFederationRoutePath("/federation/projected-accounts/import-all", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore || !deps.credentialStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const sourcePeerId = typeof request.body?.sourcePeerId === "string" ? request.body.sourcePeerId.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";

    if (!sourcePeerId || !providerId) {
      reply.code(400).send({ error: "source_peer_id_and_provider_id_required" });
      return;
    }

    const peer = await deps.sqlFederationStore.getPeer(sourcePeerId);
    const credential = peer ? extractPeerCredential(peer.auth) : undefined;
    if (!peer || !credential) {
      reply.code(400).send({ error: "peer_or_credential_not_found" });
      return;
    }

    const controlBaseUrl = peer.controlBaseUrl ?? peer.baseUrl;
    const projectedAccounts = await deps.sqlFederationStore.listProjectedAccounts(undefined);
    const filteredAccounts = projectedAccounts.filter((account) => account.sourcePeerId === sourcePeerId && account.providerId === providerId);

    const now = Date.now();
    const oauthLeaseRefreshBufferMs = 10 * 60_000;
    const localExpiresByKey = new Map<string, number | undefined>();

    try {
      const providers = await deps.credentialStore.listProviders(false);
      for (const provider of providers) {
        for (const localAccount of provider.accounts) {
          localExpiresByKey.set(`${provider.id}\0${localAccount.id}`, localAccount.expiresAt);
        }
      }
    } catch {
      // ignore local credential inspection errors
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const account of filteredAccounts) {
      const projectedAuthType = typeof account.metadata.authType === "string"
        ? String(account.metadata.authType)
        : undefined;
      const credentialMobility = typeof account.metadata.credentialMobility === "string"
        ? String(account.metadata.credentialMobility).trim()
        : undefined;
      const isOauthLease = projectedAuthType === "oauth_bearer" && credentialMobility === "access_token_only";

      if (account.availabilityState === "imported" && !isOauthLease) {
        continue;
      }

      if (isOauthLease && account.availabilityState === "imported") {
        const localExpiresAt = localExpiresByKey.get(`${account.providerId}\0${account.accountId}`);
        if (
          typeof localExpiresAt === "number"
          && Number.isFinite(localExpiresAt)
          && localExpiresAt > now + oauthLeaseRefreshBufferMs
        ) {
          continue;
        }
      }

      if (!projectedAccountAllowsCredentialImport(account)) {
        failed += 1;
        errors.push(`${account.accountId}: credential_non_importable`);
        continue;
      }

      try {
        const remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
          url: `${controlBaseUrl}${resolveFederationRoutePath("/federation/accounts/export", options)}`,
          credential,
          timeoutMs: context.federationRequestTimeoutMs ?? 5000,
          method: "POST",
          body: {
            providerId: account.providerId,
            accountId: account.accountId,
          },
        });

        if (remoteExport.account.authType === "oauth_bearer") {
          await deps.credentialStore.upsertOAuthAccount(
            remoteExport.account.providerId,
            remoteExport.account.accountId,
            remoteExport.account.secret,
            undefined,
            remoteExport.account.expiresAt,
            remoteExport.account.chatgptAccountId,
            remoteExport.account.email,
            remoteExport.account.subject,
            remoteExport.account.planType,
          );
        } else {
          await deps.credentialStore.upsertApiKeyAccount(
            remoteExport.account.providerId,
            remoteExport.account.accountId,
            remoteExport.account.secret,
          );
        }

        const marked = await deps.sqlFederationStore.markProjectedAccountImported({
          sourcePeerId,
          providerId: account.providerId,
          accountId: account.accountId,
        });
        if (marked) {
          await deps.sqlFederationStore.appendDiffEvent({
            ownerSubject: marked.ownerSubject,
            entityType: "projected_account",
            entityKey: `${marked.sourcePeerId}:${marked.providerId}:${marked.accountId}`,
            op: "mark_imported",
            payload: {
              providerId: marked.providerId,
              accountId: marked.accountId,
              availabilityState: marked.availabilityState,
              importedAt: marked.importedAt,
            },
          });
        }

        imported += 1;
      } catch (error) {
        failed += 1;
        errors.push(`${account.accountId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await deps.keyPool.warmup().catch(() => undefined);

    reply.send({ imported, failed, errors: errors.slice(0, 10) });
  });

  app.get<{
    Querystring: { readonly sinceMs?: string; readonly limit?: string; readonly afterTimestampMs?: string; readonly afterId?: string };
  }>(resolveFederationRoutePath("/federation/usage-export", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const sinceMs = typeof request.query.sinceMs === "string" ? Number.parseInt(request.query.sinceMs, 10) : 0;
    const limit = toSafeLimit(request.query.limit, 500, 5000);
    const afterTimestampMs = typeof request.query.afterTimestampMs === "string" ? Number.parseInt(request.query.afterTimestampMs, 10) : undefined;
    const afterId = typeof request.query.afterId === "string" && request.query.afterId.trim().length > 0
      ? request.query.afterId.trim()
      : undefined;

    const safeSinceMs = Number.isFinite(sinceMs) ? sinceMs : 0;
    const after = afterId && typeof afterTimestampMs === "number" && Number.isFinite(afterTimestampMs)
      ? { timestampMs: afterTimestampMs, id: afterId }
      : undefined;
    const entries = deps.sqlRequestUsageStore
      ? await deps.sqlRequestUsageStore.listEntriesSince(safeSinceMs, {}, limit, after)
      : deps.requestLogStore.snapshotSinceWithLimit(safeSinceMs, limit, after);

    reply.send({ entries });
  });

  app.post<{
    Body: { readonly entries?: readonly unknown[] };
  }>(resolveFederationRoutePath("/federation/usage-import", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlRequestUsageStore) {
      reply.code(503).send({ error: "request_usage_store_not_supported" });
      return;
    }

    const rawEntries = Array.isArray(request.body?.entries) ? request.body.entries : [];
    if (rawEntries.length === 0) {
      reply.code(400).send({ error: "entries_required" });
      return;
    }

    let importedCount = 0;
    for (const candidate of rawEntries) {
      const entry = sanitizeFederationUsageEntry(candidate);
      if (!entry) {
        continue;
      }

      await deps.sqlRequestUsageStore.upsertEntry(entry);
      importedCount += 1;
    }

    reply.send({ importedCount });
  });

  app.post<{
    Body: { readonly peerId?: string; readonly ownerSubject?: string; readonly sinceMs?: number; readonly pullUsage?: boolean };
  }>(resolveFederationRoutePath("/federation/sync/pull", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const sqlFederationStore = deps.sqlFederationStore;

    const peerId = typeof request.body?.peerId === "string" ? request.body.peerId.trim() : "";
    if (!peerId) {
      reply.code(400).send({ error: "peer_id_required" });
      return;
    }

    const peer = await sqlFederationStore.getPeer(peerId);
    if (!peer) {
      reply.code(404).send({ error: "peer_not_found" });
      return;
    }

    const ownerSubject = typeof request.body?.ownerSubject === "string" && request.body.ownerSubject.trim().length > 0
      ? request.body.ownerSubject.trim()
      : peer.ownerSubject;
    const credential = extractPeerCredential(peer.auth);
    if (!credential) {
      await sqlFederationStore.upsertSyncState({ peerId, lastError: "peer auth credential missing" });
      reply.code(400).send({ error: "peer_auth_credential_missing" });
      return;
    }

    const controlBaseUrl = peer.controlBaseUrl ?? peer.baseUrl;
    const syncState = await sqlFederationStore.getSyncState(peerId);
    const afterSeq = syncState?.lastPulledSeq ?? 0;
    const requestedSinceMs = typeof request.body?.sinceMs === "number" && Number.isFinite(request.body.sinceMs)
      ? request.body.sinceMs
      : syncState?.lastPullAt
        ? Date.parse(syncState.lastPullAt)
        : 0;

    try {
      const [remoteDiff, remoteAccounts] = await Promise.all([
        fetchFederationJson<{ readonly ownerSubject: string; readonly events: ReadonlyArray<{ readonly seq: number }> }>({
          url: `${controlBaseUrl}${resolveFederationRoutePath("/federation/diff-events", options)}?ownerSubject=${encodeURIComponent(ownerSubject)}&afterSeq=${afterSeq}&limit=500`,
          credential,
          timeoutMs: context.federationRequestTimeoutMs ?? 5000,
        }),
        fetchFederationJson<{ readonly localAccounts: ReadonlyArray<{
          readonly providerId: string;
          readonly accountId: string;
          readonly authType?: "api_key" | "oauth_bearer";
          readonly planType?: string;
          readonly chatgptAccountId?: string;
          readonly email?: string;
          readonly subject?: string;
          readonly ownerSubject?: string;
          readonly hasCredentials: boolean;
          readonly knowledgeSources: readonly string[];
        }>; readonly projectedAccounts: ReadonlyArray<{
          readonly sourcePeerId: string;
          readonly ownerSubject: string;
          readonly providerId: string;
          readonly accountId: string;
          readonly accountSubject?: string;
          readonly chatgptAccountId?: string;
          readonly email?: string;
          readonly planType?: string;
          readonly availabilityState: "descriptor" | "remote_route" | "imported";
          readonly warmRequestCount: number;
          readonly metadata: Record<string, unknown>;
        }> }>({
          url: `${controlBaseUrl}${resolveFederationRoutePath("/federation/accounts", options)}?ownerSubject=${encodeURIComponent(ownerSubject)}`,
          credential,
          timeoutMs: context.federationRequestTimeoutMs ?? 5000,
        }),
      ]);

      const importedProjectedAccounts: Array<Awaited<ReturnType<typeof sqlFederationStore.upsertProjectedAccount>>> = [];
      const seenProjectedKeys = new Set<string>();
      const appendProjectedRecord = async (record: Awaited<ReturnType<typeof sqlFederationStore.upsertProjectedAccount>>): Promise<void> => {
        const key = `${record.sourcePeerId}\0${record.providerId}\0${record.accountId}`;
        if (seenProjectedKeys.has(key)) {
          return;
        }

        seenProjectedKeys.add(key);
        importedProjectedAccounts.push(record);
        await sqlFederationStore.appendDiffEvent({
          ownerSubject: record.ownerSubject,
          entityType: "projected_account",
          entityKey: `${record.sourcePeerId}:${record.providerId}:${record.accountId}`,
          op: "upsert",
          payload: {
            providerId: record.providerId,
            accountId: record.accountId,
            availabilityState: record.availabilityState,
            sourcePeerId: record.sourcePeerId,
            email: record.email,
            chatgptAccountId: record.chatgptAccountId,
          },
        });
      };

      for (const account of remoteAccounts.localAccounts) {
        const authType = account.authType;
        const record = await sqlFederationStore.upsertProjectedAccount({
          sourcePeerId: peer.id,
          ownerSubject,
          providerId: account.providerId,
          accountId: account.accountId,
          accountSubject: account.subject,
          chatgptAccountId: account.chatgptAccountId,
          email: account.email,
          planType: account.planType,
          availabilityState: authType === "oauth_bearer" ? "remote_route" : "descriptor",
          metadata: {
            hasCredentials: account.hasCredentials,
            knowledgeSources: account.knowledgeSources,
            authType,
            credentialMobility: authType === "oauth_bearer" ? "access_token_only" : "importable",
            refreshAuthority: authType === "oauth_bearer" ? "owner_only" : "portable",
          },
        });
        await appendProjectedRecord(record);
      }

      for (const account of remoteAccounts.projectedAccounts) {
        const authType = typeof account.metadata.authType === "string" ? account.metadata.authType : undefined;
        const knowledgeSources = Array.isArray(account.metadata.knowledgeSources)
          ? account.metadata.knowledgeSources.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        const record = await sqlFederationStore.upsertProjectedAccount({
          sourcePeerId: peer.id,
          ownerSubject,
          providerId: account.providerId,
          accountId: account.accountId,
          accountSubject: account.accountSubject,
          chatgptAccountId: account.chatgptAccountId,
          email: account.email,
          planType: account.planType,
          availabilityState: account.availabilityState,
          metadata: {
            ...account.metadata,
            authType,
            knowledgeSources,
          },
        });
        await appendProjectedRecord(record);
      }

      let importedUsageCount = 0;
      const usagePageSize = 5000;
      if (request.body?.pullUsage !== false && deps.sqlRequestUsageStore) {
        let cursor: { readonly timestampMs: number; readonly id: string } | undefined;
        while (true) {
          const query = new URLSearchParams({
            sinceMs: String(Number.isFinite(requestedSinceMs) ? requestedSinceMs : 0),
            limit: String(usagePageSize),
          });
          if (cursor) {
            query.set("afterTimestampMs", String(cursor.timestampMs));
            query.set("afterId", cursor.id);
          }

          const remoteUsage = await fetchFederationJson<{ readonly entries: readonly unknown[] }>({
            url: `${controlBaseUrl}${resolveFederationRoutePath("/federation/usage-export", options)}?${query.toString()}`,
            credential,
            timeoutMs: context.federationRequestTimeoutMs ?? 5000,
          });

          let lastEntry: RequestLogEntry | undefined;
          for (const candidate of remoteUsage.entries) {
            const entry = sanitizeFederationUsageEntry(candidate);
            if (!entry) {
              continue;
            }

            await deps.sqlRequestUsageStore.upsertEntry(entry);
            importedUsageCount += 1;
            lastEntry = entry;
          }

          if (remoteUsage.entries.length < usagePageSize || !lastEntry) {
            break;
          }

          cursor = { timestampMs: lastEntry.timestamp, id: lastEntry.id };
        }
      }

      const highestSeq = remoteDiff.events.reduce((current, event) => Math.max(current, event.seq), afterSeq);
      const nextSyncState = await sqlFederationStore.upsertSyncState({
        peerId,
        lastPulledSeq: highestSeq,
        lastPullAt: true,
        lastError: null,
      });

      reply.send({
        peer,
        ownerSubject,
        importedProjectedAccountsCount: importedProjectedAccounts.length,
        importedUsageCount,
        remoteDiffCount: remoteDiff.events.length,
        syncState: nextSyncState,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await sqlFederationStore.upsertSyncState({ peerId, lastError: detail });
      reply.code(502).send({ error: "federation_pull_failed", detail });
    }
  });

  app.post<{
    Body: { readonly sourcePeerId?: string; readonly providerId?: string; readonly accountId?: string };
  }>(resolveFederationRoutePath("/federation/projected-accounts/routed", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }
    const sqlFederationStore = deps.sqlFederationStore;

    const sourcePeerId = typeof request.body?.sourcePeerId === "string" ? request.body.sourcePeerId.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!sourcePeerId || !providerId || !accountId) {
      reply.code(400).send({ error: "source_peer_id_provider_id_and_account_id_required" });
      return;
    }

    let account = await sqlFederationStore.noteProjectedAccountRouted({ sourcePeerId, providerId, accountId });
    if (!account) {
      reply.code(404).send({ error: "projected_account_not_found" });
      return;
    }

    let importedCredential = false;
    const allowCredentialImport = projectedAccountAllowsCredentialImport(account);
    const federationRequestTimeoutMs = context.federationRequestTimeoutMs ?? 5000;
    if (allowCredentialImport && shouldWarmImportProjectedAccount(account.warmRequestCount)) {
      const importResult = await sqlFederationStore.withProjectedAccountImportLock({ sourcePeerId, providerId, accountId }, async (tx) => {
        const latest = await sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId }, tx);
        if (!latest) {
          return undefined;
        }
        const latestAuthType = latest.metadata.authType;
        const latestMobility = typeof latest.metadata.credentialMobility === "string"
          ? latest.metadata.credentialMobility.trim()
          : undefined;
        const latestOauthLeaseable = latestAuthType === "oauth_bearer" && latestMobility === "access_token_only";
        if (latest.availabilityState === "imported" && !latestOauthLeaseable) {
          return { account: latest, importedCredential: false };
        }

        const peer = await sqlFederationStore.getPeer(sourcePeerId, tx);
        const credential = peer ? extractPeerCredential(peer.auth) : undefined;
        if (!peer || !credential) {
          return { account: latest, importedCredential: false };
        }

        try {
          const remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
            url: `${peer.controlBaseUrl ?? peer.baseUrl}${resolveFederationRoutePath("/federation/accounts/export", options)}`,
            credential,
            timeoutMs: federationRequestTimeoutMs,
            method: "POST",
            body: {
              providerId: latest.providerId,
              accountId: latest.accountId,
            },
          });

          if (remoteExport.account.authType === "oauth_bearer") {
            await deps.credentialStore.upsertOAuthAccount(
              remoteExport.account.providerId,
              remoteExport.account.accountId,
              remoteExport.account.secret,
              undefined,
              remoteExport.account.expiresAt,
              remoteExport.account.chatgptAccountId,
              remoteExport.account.email,
              remoteExport.account.subject,
              remoteExport.account.planType,
            );
          } else {
            await deps.credentialStore.upsertApiKeyAccount(
              remoteExport.account.providerId,
              remoteExport.account.accountId,
              remoteExport.account.secret,
            );
          }

          const imported = await sqlFederationStore.markProjectedAccountImported({ sourcePeerId, providerId, accountId }, tx);
          return { account: imported ?? latest, importedCredential: true };
        } catch (error) {
          app.log.warn({ error: error instanceof Error ? error.message : String(error), sourcePeerId, providerId, accountId }, "failed warm federation credential import");
          return { account: latest, importedCredential: false };
        }
      });

      if (importResult) {
        account = importResult.account;
        importedCredential = importResult.importedCredential;
      } else {
        const latest = await sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId });
        if (latest) {
          account = latest;
          importedCredential = latest.availabilityState === "imported";
        }
      }
    }

    await sqlFederationStore.appendDiffEvent({
      ownerSubject: account.ownerSubject,
      entityType: "projected_account",
      entityKey: `${account.sourcePeerId}:${account.providerId}:${account.accountId}`,
      op: "note_routed",
      payload: {
        providerId: account.providerId,
        accountId: account.accountId,
        availabilityState: account.availabilityState,
        warmRequestCount: account.warmRequestCount,
        importedCredential,
        credentialImportAllowed: allowCredentialImport,
      },
    });

    reply.send({ account, importedCredential });
  });

  app.post<{
    Body: { readonly sourcePeerId?: string; readonly providerId?: string; readonly accountId?: string };
  }>(resolveFederationRoutePath("/federation/projected-accounts/imported", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const sourcePeerId = typeof request.body?.sourcePeerId === "string" ? request.body.sourcePeerId.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!sourcePeerId || !providerId || !accountId) {
      reply.code(400).send({ error: "source_peer_id_provider_id_and_account_id_required" });
      return;
    }

    const existing = await deps.sqlFederationStore.getProjectedAccount({ sourcePeerId, providerId, accountId });
    if (existing && !projectedAccountAllowsCredentialImport(existing)) {
      reply.code(409).send({
        error: "credential_non_importable",
        detail: "oauth_bearer projected accounts are route-only and cannot be marked imported",
      });
      return;
    }

    const account = await deps.sqlFederationStore.markProjectedAccountImported({ sourcePeerId, providerId, accountId });
    if (!account) {
      reply.code(404).send({ error: "projected_account_not_found" });
      return;
    }

    await deps.sqlFederationStore.appendDiffEvent({
      ownerSubject: account.ownerSubject,
      entityType: "projected_account",
      entityKey: `${account.sourcePeerId}:${account.providerId}:${account.accountId}`,
      op: "mark_imported",
      payload: {
        providerId: account.providerId,
        accountId: account.accountId,
        availabilityState: account.availabilityState,
        importedAt: account.importedAt,
      },
    });

    reply.send({ account });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string; readonly subjectDid?: string };
  }>(resolveFederationRoutePath("/federation/tenant-provider-policies", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const subjectDid = typeof request.query.subjectDid === "string" && request.query.subjectDid.trim().length > 0
      ? request.query.subjectDid.trim()
      : undefined;

    const policies = await deps.sqlTenantProviderPolicyStore.listPolicies({ ownerSubject, subjectDid });
    reply.send({ policies });
  });

  app.post<{
    Body: {
      readonly subjectDid?: string;
      readonly providerId?: string;
      readonly providerKind?: string;
      readonly ownerSubject?: string;
      readonly shareMode?: string;
      readonly trustTier?: string;
      readonly allowedModels?: readonly string[];
      readonly maxRequestsPerMinute?: number | string;
      readonly maxConcurrentRequests?: number | string;
      readonly encryptedChannelRequired?: boolean;
      readonly warmImportThreshold?: number | string;
      readonly notes?: string;
    };
  }>(resolveFederationRoutePath("/federation/tenant-provider-policies", options), async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const subjectDid = typeof request.body?.subjectDid === "string" ? request.body.subjectDid.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const ownerSubject = typeof request.body?.ownerSubject === "string" ? request.body.ownerSubject.trim() : "";

    if (!subjectDid || !providerId || !ownerSubject) {
      reply.code(400).send({ error: "subject_did_provider_id_and_owner_subject_required" });
      return;
    }

    const allowedModels = Array.isArray(request.body?.allowedModels)
      ? request.body.allowedModels.filter((entry): entry is string => typeof entry === "string")
      : undefined;

    const policy = await deps.sqlTenantProviderPolicyStore.upsertPolicy({
      subjectDid,
      providerId,
      providerKind: typeof request.body?.providerKind === "string"
        ? normalizeTenantProviderKind(request.body.providerKind)
        : undefined,
      ownerSubject,
      shareMode: typeof request.body?.shareMode === "string"
        ? normalizeTenantProviderShareMode(request.body.shareMode)
        : undefined,
      trustTier: typeof request.body?.trustTier === "string"
        ? normalizeTenantProviderTrustTier(request.body.trustTier)
        : undefined,
      allowedModels,
      maxRequestsPerMinute: parseOptionalPositiveInteger(request.body?.maxRequestsPerMinute),
      maxConcurrentRequests: parseOptionalPositiveInteger(request.body?.maxConcurrentRequests),
      encryptedChannelRequired: request.body?.encryptedChannelRequired,
      warmImportThreshold: parseOptionalPositiveInteger(request.body?.warmImportThreshold),
      notes: typeof request.body?.notes === "string" ? request.body.notes : undefined,
    });

    reply.code(201).send({ policy });
  });
}
