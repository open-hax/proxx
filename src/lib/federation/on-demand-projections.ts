import type { FastifyBaseLogger } from "fastify";

import { toErrorMessage } from "../errors/index.js";
import { fetchFederationJson, extractPeerCredential } from "./federation-helpers.js";
import { resolveFederationRoutePath } from "../../routes/federation/prefix.js";
import type { SqlFederationStore } from "../db/sql-federation-store.js";
import type { FederationPeerRecord } from "../db/sql-federation-store.js";

function resolveOnDemandPullEnabled(): boolean {
  const raw = process.env.FEDERATION_ON_DEMAND_PULL_ENABLED?.trim();
  if (!raw) {
    return true;
  }
  return /^(1|true|yes|on)$/iu.test(raw);
}

export function resolveOnDemandPullTtlMs(): number {
  const raw = process.env.FEDERATION_ON_DEMAND_PULL_TTL_MS?.trim();
  if (!raw) {
    return 60_000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

type RemoteFederationAccountsPayload = {
  readonly localAccounts: ReadonlyArray<{
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
  }>;
  readonly projectedAccounts: ReadonlyArray<{
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
  }>;
};

// In-flight gate to prevent thundering herd when many requests trigger on-demand pulling.
const inFlightPullByPeerId = new Map<string, Promise<void>>();

async function fetchRemoteAccounts(input: {
  readonly controlBaseUrl: string;
  readonly ownerSubject: string;
  readonly credential: string;
  readonly timeoutMs: number;
}): Promise<RemoteFederationAccountsPayload> {
  // Prefer API v1.
  const v1 = `${input.controlBaseUrl}${resolveFederationRoutePath("/federation/accounts", { prefix: "/api/v1" })}?ownerSubject=${encodeURIComponent(input.ownerSubject)}`;
  try {
    return await fetchFederationJson<RemoteFederationAccountsPayload>({
      url: v1,
      credential: input.credential,
      timeoutMs: input.timeoutMs,
    });
  } catch (_error) {
    // Back-compat fallback: legacy prefix.
    const legacy = `${input.controlBaseUrl}${resolveFederationRoutePath("/federation/accounts")}?ownerSubject=${encodeURIComponent(input.ownerSubject)}`;
    return await fetchFederationJson<RemoteFederationAccountsPayload>({
      url: legacy,
      credential: input.credential,
      timeoutMs: input.timeoutMs,
    });
  }
}

export async function ensureFederationProjectedAccountsFresh(input: {
  readonly logger?: FastifyBaseLogger;
  readonly sqlFederationStore: SqlFederationStore;
  readonly ownerSubject: string;
  readonly timeoutMs: number;
}): Promise<{ readonly pulledPeerIds: readonly string[] } | undefined> {
  if (!resolveOnDemandPullEnabled()) {
    return undefined;
  }

  const ttlMs = resolveOnDemandPullTtlMs();
  const now = Date.now();
  const peers = await input.sqlFederationStore.listPeers(input.ownerSubject);
  const activePeers = peers.filter((peer) => peer.status.trim().toLowerCase() === "active");
  if (activePeers.length === 0) {
    return { pulledPeerIds: [] };
  }

  const pulledPeerIds: string[] = [];

  for (const peer of activePeers) {
    const syncState = await input.sqlFederationStore.getSyncState(peer.id);
    const lastPullAtMs = syncState?.lastPullAt ? Date.parse(syncState.lastPullAt) : NaN;
    const isFresh = Number.isFinite(lastPullAtMs) && ttlMs > 0 && (now - lastPullAtMs) < ttlMs;
    if (isFresh) {
      continue;
    }

    const existingInFlight = inFlightPullByPeerId.get(peer.id);
    if (existingInFlight) {
      await existingInFlight.catch(() => undefined);
      continue;
    }

    const promise = pullPeerProjectedAccounts({
      logger: input.logger,
      sqlFederationStore: input.sqlFederationStore,
      peer,
      ownerSubject: input.ownerSubject,
      timeoutMs: input.timeoutMs,
    });
    inFlightPullByPeerId.set(peer.id, promise);

    try {
      await promise;
      pulledPeerIds.push(peer.id);
    } finally {
      inFlightPullByPeerId.delete(peer.id);
    }
  }

  return { pulledPeerIds };
}

async function pullPeerProjectedAccounts(input: {
  readonly logger?: FastifyBaseLogger;
  readonly sqlFederationStore: SqlFederationStore;
  readonly peer: FederationPeerRecord;
  readonly ownerSubject: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const credential = extractPeerCredential(input.peer.auth);
  if (!credential) {
    await input.sqlFederationStore.upsertSyncState({ peerId: input.peer.id, lastError: "peer auth credential missing" });
    return;
  }

  const controlBaseUrl = input.peer.controlBaseUrl ?? input.peer.baseUrl;

  try {
    const remoteAccounts = await fetchRemoteAccounts({
      controlBaseUrl,
      ownerSubject: input.ownerSubject,
      credential,
      timeoutMs: input.timeoutMs,
    });

    for (const account of remoteAccounts.localAccounts) {
      const authType = account.authType;
      await input.sqlFederationStore.upsertProjectedAccount({
        sourcePeerId: input.peer.id,
        ownerSubject: input.ownerSubject,
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
    }

    for (const account of remoteAccounts.projectedAccounts) {
      const authType = typeof account.metadata.authType === "string" ? account.metadata.authType : undefined;
      const knowledgeSources = Array.isArray(account.metadata.knowledgeSources)
        ? account.metadata.knowledgeSources.filter((entry): entry is string => typeof entry === "string")
        : undefined;

      await input.sqlFederationStore.upsertProjectedAccount({
        sourcePeerId: input.peer.id,
        ownerSubject: input.ownerSubject,
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
    }

    await input.sqlFederationStore.upsertSyncState({
      peerId: input.peer.id,
      lastPullAt: true,
      lastError: null,
    });
  } catch (error) {
    const detail = toErrorMessage(error);
    input.logger?.warn({
      peerId: input.peer.id,
      ownerSubject: input.ownerSubject,
      error: detail,
    }, "federation on-demand pull failed");
    await input.sqlFederationStore.upsertSyncState({ peerId: input.peer.id, lastError: detail });
  }
}
