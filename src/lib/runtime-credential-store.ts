import { CredentialStore, type CredentialProviderView, type CredentialStoreLike } from "./credential-store.js";
import { SqlCredentialStore } from "./db/sql-credential-store.js";

export class RuntimeCredentialStore implements CredentialStoreLike {
  public constructor(
    private readonly fileStore: CredentialStore,
    private readonly sqlStore?: SqlCredentialStore,
  ) {}

  public async listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    const fileProviders = await this.fileStore.listProviders(revealSecrets);
    if (!this.sqlStore) {
      return fileProviders;
    }

    const sqlProviders = await this.sqlStore.listProviders(revealSecrets);
    const sqlProviderIds = new Set(sqlProviders.map((provider) => provider.id));
    return [...sqlProviders, ...fileProviders.filter((provider) => !sqlProviderIds.has(provider.id))];
  }

  public async upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void> {
    if (this.sqlStore) {
      await this.sqlStore.upsertApiKeyAccount(providerId, accountId, apiKey);
      return;
    }

    await this.fileStore.upsertApiKeyAccount(providerId, accountId, apiKey);
  }

  public async upsertOAuthAccount(
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
    if (this.sqlStore) {
      await this.sqlStore.upsertOAuthAccount(
        providerId,
        accountId,
        accessToken,
        refreshToken,
        expiresAt,
        chatgptAccountId,
        email,
        subject,
        planType,
      );
      return;
    }

    await this.fileStore.upsertOAuthAccount(
      providerId,
      accountId,
      accessToken,
      refreshToken,
      expiresAt,
      chatgptAccountId,
      email,
      subject,
      planType,
    );
  }

  public async flush(): Promise<void> {
    if (this.sqlStore) {
      return;
    }

    await this.fileStore.flush();
  }

  public async removeAccount(providerId: string, accountId: string): Promise<boolean> {
    if (this.sqlStore) {
      return this.sqlStore.removeAccount(providerId, accountId);
    }

    return this.fileStore.removeAccount(providerId, accountId);
  }
}
