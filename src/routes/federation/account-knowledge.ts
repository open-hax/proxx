import type { CredentialStoreLike } from "../../lib/credential-store.js";
import type { FederationProjectedAccountRecord } from "../../lib/db/sql-federation-store.js";

export interface FederationKnownAccountSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly authType?: "api_key" | "oauth_bearer";
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly ownerSubject?: string;
  readonly sourcePeerId?: string;
  readonly projectedState?: string;
  readonly warmRequestCount?: number;
  readonly hasCredentials: boolean;
  readonly knowledgeSources: readonly string[];
}

export interface FederationAccountsResponse {
  readonly ownerSubject: string | null;
  readonly localAccounts: readonly FederationKnownAccountSummary[];
  readonly projectedAccounts: readonly FederationProjectedAccountRecord[];
  readonly knownAccounts: readonly FederationKnownAccountSummary[];
}

export interface FederationCredentialExport {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly secret: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

function accountKnowledgeKey(providerId: string, accountId: string): string {
  return `${providerId}\0${accountId}`;
}

export async function buildFederationAccountKnowledge(
  credentialStore: CredentialStoreLike,
  projectedAccounts: readonly FederationProjectedAccountRecord[],
  options: {
    readonly ownerSubject?: string;
    readonly defaultOwnerSubject?: string;
  } = {},
): Promise<{
  readonly localAccounts: readonly FederationKnownAccountSummary[];
  readonly knownAccounts: readonly FederationKnownAccountSummary[];
}> {
  const providers = await credentialStore.listProviders(false);
  const localAccounts: FederationKnownAccountSummary[] = [];
  const known = new Map<string, FederationKnownAccountSummary>();
  const requestedOwnerSubject = options.ownerSubject?.trim();
  const defaultOwnerSubject = options.defaultOwnerSubject?.trim();
  const includeAllLocalAccounts = !requestedOwnerSubject
    || (defaultOwnerSubject !== undefined && defaultOwnerSubject.length > 0 && requestedOwnerSubject === defaultOwnerSubject);
  const projectedAccountKeys = new Set(projectedAccounts.map((projected) => accountKnowledgeKey(projected.providerId, projected.accountId)));

  for (const provider of providers) {
    for (const account of provider.accounts) {
      const key = accountKnowledgeKey(provider.id, account.id);
      const accountHasSubject = typeof account.subject === "string" && account.subject.length > 0;
      const hasNoOwner = !accountHasSubject;
      const matchesOwner = accountHasSubject && account.subject === requestedOwnerSubject;
      if (!includeAllLocalAccounts && !hasNoOwner && !matchesOwner && !projectedAccountKeys.has(key)) {
        continue;
      }

      const summary: FederationKnownAccountSummary = {
        providerId: provider.id,
        accountId: account.id,
        displayName: account.displayName,
        authType: account.authType,
        planType: account.planType,
        chatgptAccountId: account.chatgptAccountId,
        email: account.email,
        subject: account.subject,
        ownerSubject: requestedOwnerSubject,
        hasCredentials: true,
        knowledgeSources: ["local_credential"],
      };
      localAccounts.push(summary);
      known.set(key, summary);
    }
  }

  for (const projected of projectedAccounts) {
    const key = accountKnowledgeKey(projected.providerId, projected.accountId);
    const existing = known.get(key);
    const projectedSource = `projected:${projected.availabilityState}`;
    if (existing) {
      known.set(key, {
        ...existing,
        ownerSubject: existing.ownerSubject ?? projected.ownerSubject,
        sourcePeerId: existing.sourcePeerId ?? projected.sourcePeerId,
        projectedState: projected.availabilityState,
        warmRequestCount: projected.warmRequestCount,
        knowledgeSources: [...new Set([...existing.knowledgeSources, projectedSource])],
      });
      continue;
    }

    known.set(key, {
      providerId: projected.providerId,
      accountId: projected.accountId,
      displayName: projected.email ?? projected.chatgptAccountId ?? projected.accountSubject ?? projected.accountId,
      planType: projected.planType,
      chatgptAccountId: projected.chatgptAccountId,
      email: projected.email,
      subject: projected.accountSubject,
      ownerSubject: projected.ownerSubject,
      sourcePeerId: projected.sourcePeerId,
      projectedState: projected.availabilityState,
      warmRequestCount: projected.warmRequestCount,
      hasCredentials: false,
      knowledgeSources: [projectedSource],
    });
  }

  const sortAccounts = (left: FederationKnownAccountSummary, right: FederationKnownAccountSummary): number =>
    left.providerId.localeCompare(right.providerId)
      || left.accountId.localeCompare(right.accountId)
      || left.displayName.localeCompare(right.displayName);

  return {
    localAccounts: [...localAccounts].sort(sortAccounts),
    knownAccounts: [...known.values()].sort(sortAccounts),
  };
}

export async function findCredentialForFederationExport(
  credentialStore: CredentialStoreLike,
  providerId: string,
  accountId: string,
): Promise<FederationCredentialExport | undefined> {
  const providers = await credentialStore.listProviders(true);
  const provider = providers.find((candidate) => candidate.id === providerId);
  const account = provider?.accounts.find((candidate) => candidate.id === accountId);
  if (!provider || !account || typeof account.secret !== "string" || account.secret.trim().length === 0) {
    return undefined;
  }

  return {
    providerId,
    accountId,
    authType: account.authType,
    secret: account.secret,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    chatgptAccountId: account.chatgptAccountId,
    email: account.email,
    subject: account.subject,
    planType: account.planType,
  };
}