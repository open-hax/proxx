import type { CredentialAccountView, CredentialProviderView, CredentialStoreLike } from "../../lib/credential-store.js";
import type { KeyPool } from "../../lib/key-pool.js";

function mergeAccount(existing: CredentialAccountView | undefined, incoming: CredentialAccountView): CredentialAccountView {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    displayName: incoming.displayName || existing.displayName,
    secretPreview: incoming.secretPreview || existing.secretPreview,
    secret: incoming.secret ?? existing.secret,
    refreshTokenPreview: incoming.refreshTokenPreview ?? existing.refreshTokenPreview,
    refreshToken: incoming.refreshToken ?? existing.refreshToken,
    expiresAt: incoming.expiresAt ?? existing.expiresAt,
    chatgptAccountId: incoming.chatgptAccountId ?? existing.chatgptAccountId,
    email: incoming.email ?? existing.email,
    subject: incoming.subject ?? existing.subject,
    planType: incoming.planType ?? existing.planType,
  };
}

function compareAccounts(left: CredentialAccountView, right: CredentialAccountView): number {
  const leftLabel = (left.email ?? left.displayName ?? left.id).toLowerCase();
  const rightLabel = (right.email ?? right.displayName ?? right.id).toLowerCase();
  return leftLabel.localeCompare(rightLabel) || left.id.localeCompare(right.id);
}

function mergeProvider(existing: CredentialProviderView | undefined, incoming: CredentialProviderView): CredentialProviderView {
  const accountsById = new Map<string, CredentialAccountView>();
  for (const account of existing?.accounts ?? []) {
    accountsById.set(account.id, account);
  }
  for (const account of incoming.accounts) {
    accountsById.set(account.id, mergeAccount(accountsById.get(account.id), account));
  }

  const accounts = [...accountsById.values()].sort(compareAccounts);
  return {
    id: incoming.id,
    authType: incoming.authType ?? existing?.authType ?? "api_key",
    accountCount: accounts.length,
    accounts,
  };
}

function keyPoolAccountToView(input: {
  readonly id: string;
  readonly authType: CredentialAccountView["authType"];
  readonly chatgptAccountId?: string;
  readonly planType?: string;
}): CredentialAccountView {
  return {
    id: input.id,
    authType: input.authType,
    displayName: input.chatgptAccountId ?? input.id,
    secretPreview: "runtime-only",
    chatgptAccountId: input.chatgptAccountId,
    planType: input.planType,
  };
}

export async function listVisibleProviders(input: {
  readonly credentialStore: CredentialStoreLike;
  readonly keyPool: KeyPool;
  readonly revealSecrets: boolean;
}): Promise<CredentialProviderView[]> {
  const storeProviders = await input.credentialStore.listProviders(input.revealSecrets).catch(() => []);
  const providerMap = new Map<string, CredentialProviderView>(
    storeProviders.map((provider) => [provider.id, provider]),
  );

  const keyPoolStatuses = await input.keyPool.getAllStatuses().catch(() => ({}));
  for (const providerId of Object.keys(keyPoolStatuses)) {
    const keyPoolAccounts = await input.keyPool.getAllAccounts(providerId).catch(() => []);
    if (keyPoolAccounts.length === 0) {
      continue;
    }

    const incoming: CredentialProviderView = {
      id: providerId,
      authType: keyPoolAccounts[0]?.authType ?? providerMap.get(providerId)?.authType ?? "api_key",
      accountCount: keyPoolAccounts.length,
      accounts: keyPoolAccounts.map((account) => keyPoolAccountToView({
        id: account.accountId,
        authType: account.authType,
        chatgptAccountId: account.chatgptAccountId,
        planType: account.planType,
      })),
    };

    providerMap.set(providerId, mergeProvider(providerMap.get(providerId), incoming));
  }

  return [...providerMap.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function listVisibleOpenAiAccounts(input: {
  readonly credentialStore: CredentialStoreLike;
  readonly keyPool: KeyPool;
  readonly providerId: string;
  readonly revealSecrets: boolean;
}): Promise<CredentialAccountView[]> {
  const providers = await listVisibleProviders(input);
  const provider = providers.find((entry) => entry.id === input.providerId);
  return (provider?.accounts ?? []).filter((account) => account.authType === "oauth_bearer");
}
