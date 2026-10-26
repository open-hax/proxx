import { kernels } from "./cljs-kernels.js";
import type { CredentialProviderView, CredentialStore, CredentialStoreLike } from "./credential-store.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";

/**
 * The credential store the host runs on: the SQL store when there is one, else
 * the file-backed one. The delegation is CLJS (`proxx.runtime.runtime-credential-store`).
 */
export class RuntimeCredentialStore implements CredentialStoreLike {
  private readonly impl: ReturnType<typeof kernels.createRuntimeCredentialStore>;

  public constructor(fileStore: CredentialStore, sqlStore?: SqlCredentialStore) {
    this.impl = kernels.createRuntimeCredentialStore(fileStore, sqlStore);
  }

  public listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    return this.impl.listProviders(revealSecrets) as Promise<CredentialProviderView[]>;
  }

  public upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void> {
    return this.impl.upsertApiKeyAccount(providerId, accountId, apiKey);
  }

  public upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
    email?: string,
    subject?: string,
    planType?: string,
  ): Promise<void> {
    return this.impl.upsertOAuthAccount(
      providerId, accountId, accessToken, refreshToken, expiresAt, chatgptAccountId, email, subject, planType,
    );
  }

  public flush(): Promise<void> {
    return this.impl.flush();
  }

  public removeAccount(providerId: string, accountId: string): Promise<boolean> {
    return this.impl.removeAccount(providerId, accountId);
  }
}
