import { Readable } from "node:stream";

import type { FastifyReply, FastifyInstance } from "fastify";

import { buildForwardHeaders } from "../proxy.js";
import { normalizeRequestedModel } from "../request-utils.js";
import { fetchWithResponseTimeout } from "../http/index.js";
import { toErrorMessage } from "../errors/index.js";
import type { TenantProviderPolicyRecord } from "../db/sql-tenant-provider-policy-store.js";
import {
  extractPeerCredential,
  fetchFederationJson,
  resolveFederationHopCount,
  resolveFederationOwnerSubject,
} from "./federation-helpers.js";
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

import { ensureFederationProjectedAccountsFresh } from "./on-demand-projections.js";
import { getActiveCljsRuntime } from "../cljs-runtime.js";
import { kernels } from "../cljs-kernels.js";

const routing = kernels.federationRouting;

export interface FederatedRoutingDeps {
  readonly app: FastifyInstance;
  readonly cljsPolicyManifestPath?: string;
  readonly sqlFederationStore: SqlFederationStore | undefined;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly keyPool: KeyPool;
  readonly sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;
}

function authorizeTenantProviderPolicy(
  deps: FederatedRoutingDeps,
  policy: TenantProviderPolicyRecord,
  input: {
    readonly ownerSubject: string;
    readonly providerKind: "local_upstream" | "peer_proxx";
    readonly requestedModel?: string;
    readonly requestKind?: string;
    readonly requiredShareMode?: "relay" | "warm_import" | "project_credentials";
  },
): boolean {
  const runtime = getActiveCljsRuntime();
  const result = runtime?.authorizeTenantProviderPolicy?.(
    deps.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
    { policy, ...input },
  );
  return result?.status === "ok" && result.allowed === true;
}

export async function noteFederatedProjectedAccountRouted(
  deps: FederatedRoutingDeps,
  input: {
    readonly projectedAccount: FederationProjectedAccountRecord;
    readonly timeoutMs: number;
    readonly requestKind?: string;
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
  // Legacy federation behavior: projected accounts may warm-import unless a
  // tenant-provider policy is present and does not authorize it.
  const warmImportAllowed = routing.warmImportAllowed(
    input.policy !== undefined,
    input.policy !== undefined && authorizeTenantProviderPolicy(deps, input.policy, {
      ownerSubject: input.policy.ownerSubject,
      providerKind: input.policy.providerKind,
      requestKind: input.requestKind,
      requiredShareMode: "warm_import",
    }),
  );
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
        const exportBody = {
          providerId: latest.providerId,
          accountId: latest.accountId,
        };

        const [exportUrl, legacyExportUrl] = routing.exportUrls(peer);
        let remoteExport: { readonly account: FederationCredentialExport };
        try {
          remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
            url: exportUrl,
            credential,
            timeoutMs: input.timeoutMs,
            method: "POST",
            body: exportBody,
          });
        } catch {
          // Back-compat retry for peers still exposing the UI export path.
          remoteExport = await fetchFederationJson<{ readonly account: FederationCredentialExport }>({
            url: legacyExportUrl,
            credential,
            timeoutMs: input.timeoutMs,
            method: "POST",
            body: exportBody,
          });
        }

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

  await sqlFederationStore.appendDiffEvent(routing.routedDiffEvent(projectedAccount, importedCredential));

  return { importedCredential, projectedAccount };
}

export async function executeFederatedRequestRouting(
  deps: FederatedRoutingDeps,
  input: {
    readonly requestHeaders: Record<string, unknown>;
    readonly requestBody: Record<string, unknown>;
    readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string; readonly tenantId?: string };
    readonly requestKind: "chat" | "responses" | "images";
    readonly providerRoutes: readonly ProviderRoute[];
    readonly upstreamPath: string;
    readonly reply: FastifyReply;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  const { app, sqlFederationStore, runtimeCredentialStore, sqlTenantProviderPolicyStore } = deps;

  if (!sqlFederationStore) {
    return false;
  }

  const hopCount = resolveFederationHopCount(input.requestHeaders);
  if (routing.hopLimitExceeded(hopCount)) {
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

  const localProviderIds = new Set(routing.localProviderIds(input.providerRoutes.map((route) => route.providerId)));
  if (localProviderIds.size === 0) {
    return false;
  }

  const requestedModel = normalizeRequestedModel(input.requestBody.model);
  const subjectDid = routing.subjectDid(input.requestAuth);

  const resolveRelayPolicy = async (providerId: string): Promise<TenantProviderPolicyRecord | null | undefined> => {
    if (!subjectDid || !sqlTenantProviderPolicyStore) {
      return undefined;
    }

    const policy = await sqlTenantProviderPolicyStore.getPolicy(subjectDid, providerId);
    if (!policy) {
      return null;
    }

    if (!authorizeTenantProviderPolicy(deps, policy, {
      ownerSubject,
      providerKind: "local_upstream",
      requestedModel,
      requestKind: input.requestKind,
      requiredShareMode: "relay",
    })) {
      return null;
    }

    return policy;
  };

  const peers = await sqlFederationStore.listPeers(ownerSubject);
  const peersById = new Map(peers
    .filter((peer) => routing.isActivePeer(peer))
    .map((peer) => [peer.id, peer] as const));

  const localProviderAccountKeys = new Set(
    (await runtimeCredentialStore.listProviders(false).catch(() => []))
      .flatMap((provider) => provider.accounts.map((account) => routing.localAccountKey(provider.id, account.id))),
  );

  type FederatedProjectedCandidate = {
    readonly peer: FederationPeerRecord;
    readonly credential: string;
    readonly projectedAccount: FederationProjectedAccountRecord;
    readonly policy: TenantProviderPolicyRecord | undefined;
  };

  const now = Date.now();
  const policyOrderProjectedAccounts = (
    projectedAccounts: readonly FederationProjectedAccountRecord[],
  ): readonly FederationProjectedAccountRecord[] => {
    const runtime = getActiveCljsRuntime();
    const result = runtime?.resolveFederationRouteCandidates?.(
      deps.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
      {
        requestKind: input.requestKind,
        providerIds: [...localProviderIds],
        projectedAccounts,
        localProviderAccountKeys: [...localProviderAccountKeys],
        nowMs: now,
      },
    );
    if (result?.status !== "ok" || !Array.isArray(result.candidates)) {
      return [];
    }
    return result.candidates as readonly FederationProjectedAccountRecord[];
  };

  const buildProjectedCandidates = async (): Promise<readonly FederatedProjectedCandidate[]> => {
    const projectedAccounts = policyOrderProjectedAccounts(await sqlFederationStore.getProjectedAccountsForOwner(ownerSubject));
    const candidates = await Promise.all(projectedAccounts.map(async (projectedAccount) => {
      const peer = peersById.get(projectedAccount.sourcePeerId);
      const credential = peer ? extractPeerCredential(peer.auth) : undefined;
      if (!peer || !credential) {
        return undefined;
      }

      const policy = await resolveRelayPolicy(projectedAccount.providerId);
      if (policy === null) {
        return undefined;
      }

      const candidate: FederatedProjectedCandidate = { peer, credential, projectedAccount, policy: policy ?? undefined };
      return candidate;
    }));
    return candidates.filter((candidate): candidate is FederatedProjectedCandidate => candidate !== undefined);
  };

  await ensureFederationProjectedAccountsFresh({
    logger: app.log,
    sqlFederationStore,
    ownerSubject,
    timeoutMs: Math.min(input.timeoutMs, 10_000),
  }).catch(() => undefined);

  let projectedCandidates = await buildProjectedCandidates();

  // If we have no projected candidates, try an on-demand pull from peers to populate projections.
  // This keeps federation routing dynamic without relying on an external periodic sync.
  if (projectedCandidates.length === 0) {
    await ensureFederationProjectedAccountsFresh({
      logger: app.log,
      sqlFederationStore,
      ownerSubject,
      timeoutMs: Math.min(input.timeoutMs, 10_000),
    }).catch(() => undefined);
    projectedCandidates = await buildProjectedCandidates();
  }

  if (projectedCandidates.length === 0) {
    return false;
  }

  const bodyText = JSON.stringify(input.requestBody);

  for (const candidate of projectedCandidates) {
    const headers = buildForwardHeaders(input.requestHeaders as never);
    for (const [name, value] of Object.entries(
      routing.forwardedRequestOverrides(candidate.credential, hopCount, ownerSubject, candidate.projectedAccount),
    )) {
      headers.set(name, value);
    }

    let remoteResponse: Response;
    try {
      remoteResponse = await fetchWithResponseTimeout(
        `${candidate.peer.baseUrl}${input.upstreamPath}`,
        {
          method: "POST",
          headers,
          body: bodyText,
          signal: input.signal,
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
      requestKind: input.requestKind,
      policy: candidate.policy,
    });

    for (const [name, value] of remoteResponse.headers.entries()) {
      if (!routing.copyableResponseHeader(name)) {
        continue;
      }
      input.reply.header(name, value);
    }
    for (const [name, value] of Object.entries(
      routing.routedResponseHeaders(ownerSubject, candidate.peer.id, candidate.projectedAccount, routed.importedCredential),
    )) {
      input.reply.header(name, value);
    }

    input.reply.code(remoteResponse.status);
    const contentType = remoteResponse.headers.get("content-type") ?? "";
    const isEventStream = routing.eventStreamContentType(contentType);

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
