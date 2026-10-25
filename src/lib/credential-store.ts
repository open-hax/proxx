import type { ProviderAuthType } from "./key-pool.js";
import { deriveOAuthMetadataFromToken } from "./account-identity.js";
import { kernels } from "./cljs-kernels.js";

/**
 * File-backed credential store. Normalizing a keys document, upsert/remove,
 * previews and the persisted JSON shape are CLJS (`proxx.credentials.store`);
 * the debounced serialised flush and process-exit hooks are its edge
 * (`proxx.runtime.credentials`). This class forwards.
 */

export interface CredentialAccountView {
  readonly id: string;
  readonly authType: ProviderAuthType;
  readonly displayName: string;
  readonly secretPreview: string;
  readonly secret?: string;
  readonly refreshTokenPreview?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

export interface CredentialProviderView {
  readonly id: string;
  readonly authType: ProviderAuthType;
  readonly accountCount: number;
  readonly accounts: CredentialAccountView[];
}

export interface CredentialStoreLike {
  listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]>;
  upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void>;
  upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
    email?: string,
    subject?: string,
    planType?: string,
  ): Promise<void>;
  flush?(): Promise<void>;
  removeAccount(providerId: string, accountId: string): Promise<boolean>;
}


interface CredentialStoreFacade {
  dispose(): void;
  close(): Promise<void>;
  flushOnExit(): void;
  flush(): Promise<void>;
  listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]>;
  upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void>;
  upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
    email?: string,
    subject?: string,
    planType?: string,
  ): Promise<void>;
  removeAccount(providerId: string, accountId: string): Promise<boolean>;
}

export class CredentialStore {
  private readonly impl: CredentialStoreFacade;

  public constructor(filePath: string, defaultProviderId: string) {
    this.impl = kernels.createCredentialStore(filePath, defaultProviderId, {
      deriveOAuthMetadata: deriveOAuthMetadataFromToken,
    }) as CredentialStoreFacade;
  }

  public dispose(): void {
    this.impl.dispose();
  }

  public close(): Promise<void> {
    return this.impl.close();
  }

  public flushOnExit(): void {
    this.impl.flushOnExit();
  }

  public flush(): Promise<void> {
    return this.impl.flush();
  }

  public listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    return this.impl.listProviders(revealSecrets);
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

  public removeAccount(providerId: string, accountId: string): Promise<boolean> {
    return this.impl.removeAccount(providerId, accountId);
  }
}
