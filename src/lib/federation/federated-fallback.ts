import { Readable } from "node:stream";

import type { FastifyReply, FastifyInstance } from "fastify";

import { buildForwardHeaders } from "../proxy.js";
import { normalizeRequestedModel } from "../request-utils.js";
import { fetchWithResponseTimeout, toErrorMessage } from "../provider-utils.js";
import {
  shareModeAllowsRelay,
  shareModeAllowsWarmImport,
  tenantProviderPolicyAllowsUse,
  type TenantProviderPolicyRecord,
} from "../tenant-provider-policy.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  resolveFederationHopCount,
  resolveFederationOwnerSubject,
} from "./federation-helpers.js";
import { isAtDid } from "./owner-credential.js";
import {
  shouldWarmImportProjectedAccount,
  type FederationPeerRecord,
  type FederationProjectedAccountRecord,
} from "../db/sql-federation-store.js";
import type { RuntimeCredentialStore } from "../runtime-credential-store.js";
import type { KeyPool } from "../key-pool.js";
import type { SqlFederationStore } from "../db/sql-federation-store.js";
import type { SqlTenantProviderPolicyStore } from "../db/sql-tenant-provider-policy-store.js";
import type { ProviderRoute } from "../provider-routing.js";
import type { FederationCredentialExport } from "../../routes/federation/account-knowledge.js";

const FEDERATION_HOP_HEADER = "x-open-hax-federation-hop";
const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";
const FEDERATION_FORCED_PROVIDER_HEADER = "x-open-hax-forced-provider";
const FEDERATION_FORCED_ACCOUNT_ID_HEADER = "x-open-hax-forced-account-id";
const FEDERATION_ROUTED_PEER_HEADER = "x-open-hax-federation-routed-peer";
const FEDERATION_ROUTED_PROVIDER_HEADER = "x-open-hax-federation-routed-provider";
const FEDERATION_ROUTED_ACCOUNT_HEADER = "x-open-hax-federation-routed-account";
const FEDERATION_IMPORTED_HEADER = "x-open-hax-federation-imported";
const FEDERATION_BLOCKED_RESPONSE_HEADERS = new Set([
  "set-cookie", "x-open-hax-federation-hop", "x-open-hax-federation-owner-subject",
  "x-open-hax-federation-routed-peer", "x-open-hax-federation-routed-provider",
  "x-open-hax-federation-routed-account", "x-open-hax-federation-imported",
  "x-open-hax-forced-provider", "x-open-hax-forced-account-id",
]);

export interface FederatedFallbackDeps {
  readonly app: FastifyInstance;
  readonly sqlFederationStore: SqlFederationStore | undefined;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly keyPool: KeyPool;
  readonly sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;
}

export async function noteFederatedProjectedAccountRouted(
  deps: FederatedFallbackDeps,
  input: {
    readonly projectedAccount: FederationProjectedAccountRecord;
    readonly timeoutMs: number;
    readonly policy?: TenantProviderPolicyRecord;
  },
): Promise<{ readonly importedCredential: boolean; readonly projectedAccount: FederationProjectedAccountRecord }> {
  const { sqlFederationStore, runtimeCredentialStore, keyPool, app } = deps;

  if (!sqlFederationStore) {
    return { importedCredential: false, projectedAccount: input.projectedAccount };
  }

  let projectedAccount = await sqlFederationStore.noteProjectedAccountRouted({
    sourcePeerId: input.projectedAccount.sourcePeerId,
    providerId: input.projectedAccount.providerId,
    accountId: input.projectedAccount.accountId,
  }) ?? input.projectedAccount;

  let importedCredential = false;
  const warmImportAllowed = input.policy ? shareModeAllowsWarmImport(input.policy.shareMode) : true;
  const warmImportThreshold = input.policy?.warmImportThreshold;
  if (warmImportAllowed && shouldWarmImportProjectedAccount(projectedAccount.warmRequestCount, warmImportThreshold)) {
    const importResult = await sqlFederationStore.withProjectedAccountImportLock({
      sourcePeerId: projectedAccount.sourcePeerId,
      providerId: projectedAccount.providerId,
      accountId: projectedAccount.accountId,
    }, async (tx) => {
      const latest = await sqlFederationStore.getProjectedAccount({
        sourcePeerId: projectedAccount.sourcePeerId,
        providerId: projectedAccount.providerId,
        accountId: projectedAccount.accountId,
      }, tx);
      if (!latest) {
        return undefined;
      }
      if (latest.availabilityState === "imported") {
        return { importedCredential: false, projectedAccount: latest };
      }

      const peer = await sqlFederationStore.getPeer(latest.sourcePeerId, tx);
      const credential = peer ? extractPeerCredential(peer.auth) : undefined;
      if (!peer || !credential) {
        return { importedCredential: false, projectedAccount: latest };
      }

      try {
        const remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
          url: `${peer.controlBaseUrl ?? peer.baseUrl}/api/ui/federation/accounts/export`,
          credential,
          timeoutMs: input.timeoutMs,
          method: "POST",
          body: {
            providerId: latest.providerId,
            accountId: latest.accountId,
          },
        });

        if (remoteExport.account.authType === "oauth_bearer") {
          await runtimeCredentialStore.upsertOAuthAccount(
            remoteExport.account.providerId,
            remoteExport.account.accountId,
            remoteExport.account.secret,
            remoteExport.account.refreshToken,
            remoteExport.account.expiresAt,
            remoteExport.account.chatgptAccountId,
            remoteExport.account.email,
            remoteExport.account.subject,
            remoteExport.account.planType,
          );
        } else {
          await runtimeCredentialStore.upsertApiKeyAccount(
            remoteExport.account.providerId,
            remoteExport.account.accountId,
            remoteExport.account.secret,
          );
        }

        await keyPool.warmup().catch(() => undefined);

        const imported = await sqlFederationStore.markProjectedAccountImported({
          sourcePeerId: latest.sourcePeerId,
          providerId: latest.providerId,
          accountId: latest.accountId,
        }, tx);
        return {
          importedCredential: true,
          projectedAccount: imported ?? latest,
        };
      } catch (error) {
        app.log.warn({
          error: toErrorMessage(error),
          sourcePeerId: latest.sourcePeerId,
          providerId: latest.providerId,
          accountId: latest.accountId,
        }, "failed warm federation credential import during request routing");
        return { importedCredential: false, projectedAccount: latest };
      }
    });

    if (importResult) {
      projectedAccount = importResult.projectedAccount;
      importedCredential = importResult.importedCredential;
    } else {
      const latest = await sqlFederationStore.getProjectedAccount({
        sourcePeerId: projectedAccount.sourcePeerId,
        providerId: projectedAccount.providerId,
        accountId: projectedAccount.accountId,
      });
      if (latest) {
        projectedAccount = latest;
        importedCredential = latest.availabilityState === "imported";
      }
    }
  }

  await sqlFederationStore.appendDiffEvent({
    ownerSubject: projectedAccount.ownerSubject,
    entityType: "projected_account",
    entityKey: `${projectedAccount.sourcePeerId}:${projectedAccount.providerId}:${projectedAccount.accountId}`,
    op: "note_routed",
    payload: {
      providerId: projectedAccount.providerId,
      accountId: projectedAccount.accountId,
      availabilityState: projectedAccount.availabilityState,
      warmRequestCount: projectedAccount.warmRequestCount,
      importedCredential,
    },
  });

  return { importedCredential, projectedAccount };
}

export async function executeFederatedRequestFallback(
  deps: FederatedFallbackDeps,
  input: {
    readonly requestHeaders: Record<string, unknown>;
    readonly requestBody: Record<string, unknown>;
    readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string; readonly tenantId?: string };
    readonly providerRoutes: readonly ProviderRoute[];
    readonly upstreamPath: string;
    readonly reply: FastifyReply;
    readonly timeoutMs: number;
  },
): Promise<boolean> {
  const { app, sqlFederationStore, runtimeCredentialStore, sqlTenantProviderPolicyStore } = deps;

  if (!sqlFederationStore) {
    return false;
  }

  const hopCount = resolveFederationHopCount(input.requestHeaders);
  if (hopCount >= 1) {
    return false;
  }

  const ownerSubject = resolveFederationOwnerSubject({
    headers: input.requestHeaders,
    requestAuth: input.requestAuth,
    hopCount,
  });
  if (!ownerSubject) {
    return false;
  }

  const localProviderIds = new Set(input.providerRoutes.map((route) => route.providerId.trim().toLowerCase()));
  if (localProviderIds.size === 0) {
    return false;
  }

  const requestedModel = normalizeRequestedModel(input.requestBody.model);
  const subjectDid = typeof input.requestAuth?.subject === "string" && isAtDid(input.requestAuth.subject)
    ? input.requestAuth.subject.trim()
    : typeof input.requestAuth?.tenantId === "string" && isAtDid(input.requestAuth.tenantId)
      ? input.requestAuth.tenantId.trim()
      : undefined;

  const resolveRelayPolicy = async (providerId: string): Promise<TenantProviderPolicyRecord | null | undefined> => {
    if (!subjectDid || !sqlTenantProviderPolicyStore) {
      return undefined;
    }

    const policy = await sqlTenantProviderPolicyStore.getPolicy(subjectDid, providerId);
    if (!policy) {
      return null;
    }

    if (!tenantProviderPolicyAllowsUse(policy, {
      ownerSubject,
      providerKind: "local_upstream",
      requestedModel,
      requiredShareMode: "relay",
    })) {
      return null;
    }

    return policy;
  };

  const peers = await sqlFederationStore.listPeers(ownerSubject);
  const peersById = new Map(peers
    .filter((peer) => peer.status.trim().toLowerCase() === "active")
    .map((peer) => [peer.id, peer] as const));

  const localProviderAccountKeys = new Set(
    (await runtimeCredentialStore.listProviders(false).catch(() => []))
      .flatMap((provider) => provider.accounts.map((account) => `${provider.id.trim().toLowerCase()}\0${account.id}`)),
  );

  type FederatedProjectedCandidate = {
    readonly peer: FederationPeerRecord;
    readonly credential: string;
    readonly projectedAccount: FederationProjectedAccountRecord;
    readonly policy: TenantProviderPolicyRecord | undefined;
  };

  const projectedCandidates = (await Promise.all((await sqlFederationStore.getProjectedAccountsForOwner(ownerSubject))
    .filter((account) => account.availabilityState !== "imported")
    .filter((account) => localProviderIds.has(account.providerId.trim().toLowerCase()))
    .filter((account) => !localProviderAccountKeys.has(`${account.providerId.trim().toLowerCase()}\0${account.accountId}`))
    .map(async (projectedAccount) => {
      const peer = peersById.get(projectedAccount.sourcePeerId);
      const credential = peer ? extractPeerCredential(peer.auth) : undefined;
      if (!peer || !credential) {
        return undefined;
      }

      const policy = await resolveRelayPolicy(projectedAccount.providerId);
      if (policy === null || (policy && !shareModeAllowsRelay(policy.shareMode))) {
        return undefined;
      }

      const candidate: FederatedProjectedCandidate = { peer, credential, projectedAccount, policy: policy ?? undefined };
      return candidate;
    })))
    .filter((candidate): candidate is FederatedProjectedCandidate => candidate !== undefined)
    .sort((left, right) => {
      const stateWeight = (value: FederationProjectedAccountRecord["availabilityState"]): number => value === "remote_route" ? 0 : 1;
      return stateWeight(left.projectedAccount.availabilityState) - stateWeight(right.projectedAccount.availabilityState)
        || right.projectedAccount.warmRequestCount - left.projectedAccount.warmRequestCount
        || left.projectedAccount.providerId.localeCompare(right.projectedAccount.providerId)
        || left.projectedAccount.accountId.localeCompare(right.projectedAccount.accountId)
        || left.projectedAccount.sourcePeerId.localeCompare(right.projectedAccount.sourcePeerId);
    });

  if (projectedCandidates.length === 0) {
    return false;
  }

  const bodyText = JSON.stringify(input.requestBody);

  for (const candidate of projectedCandidates) {
    const headers = buildForwardHeaders(input.requestHeaders as never);
    headers.set("authorization", `Bearer ${candidate.credential}`);
    headers.set(FEDERATION_HOP_HEADER, String(hopCount + 1));
    headers.set(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
    headers.set(FEDERATION_FORCED_PROVIDER_HEADER, candidate.projectedAccount.providerId);
    headers.set(FEDERATION_FORCED_ACCOUNT_ID_HEADER, candidate.projectedAccount.accountId);

    let remoteResponse: Response;
    try {
      remoteResponse = await fetchWithResponseTimeout(
        `${candidate.peer.baseUrl}${input.upstreamPath}`,
        {
          method: "POST",
          headers,
          body: bodyText,
        },
        input.timeoutMs,
      );
    } catch (error) {
      app.log.warn({
        error: toErrorMessage(error),
        peerId: candidate.peer.id,
        upstreamPath: input.upstreamPath,
        providerId: candidate.projectedAccount.providerId,
        accountId: candidate.projectedAccount.accountId,
      }, "federated request attempt failed before response");
      continue;
    }

    if (!remoteResponse.ok) {
      try {
        await remoteResponse.arrayBuffer();
      } catch {
        // ignore response drain failure while trying the next candidate
      }
      app.log.warn({
        peerId: candidate.peer.id,
        status: remoteResponse.status,
        providerId: candidate.projectedAccount.providerId,
        accountId: candidate.projectedAccount.accountId,
      }, "federated request attempt returned non-success response");
      continue;
    }

    const routed = await noteFederatedProjectedAccountRouted(deps, {
      projectedAccount: candidate.projectedAccount,
      timeoutMs: input.timeoutMs,
      policy: candidate.policy,
    });

    for (const [name, value] of remoteResponse.headers.entries()) {
      if (FEDERATION_BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      input.reply.header(name, value);
    }
    input.reply.header(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
    input.reply.header(FEDERATION_ROUTED_PEER_HEADER, candidate.peer.id);
    input.reply.header(FEDERATION_ROUTED_PROVIDER_HEADER, candidate.projectedAccount.providerId);
    input.reply.header(FEDERATION_ROUTED_ACCOUNT_HEADER, candidate.projectedAccount.accountId);
    if (routed.importedCredential) {
      input.reply.header(FEDERATION_IMPORTED_HEADER, "true");
    }

    input.reply.code(remoteResponse.status);
    const contentType = remoteResponse.headers.get("content-type") ?? "";
    const isEventStream = contentType.toLowerCase().includes("text/event-stream");

    if (!remoteResponse.body) {
      input.reply.send(await remoteResponse.text());
      return true;
    }

    if (isEventStream) {
      input.reply.removeHeader("content-length");
      input.reply.send(Readable.fromWeb(remoteResponse.body as never));
      return true;
    }

    input.reply.send(Buffer.from(await remoteResponse.arrayBuffer()));
    return true;
  }

  return false;
}
