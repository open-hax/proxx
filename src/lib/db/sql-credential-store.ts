import type { Sql } from "./index.js";
import type { ProviderCredential, ProviderAuthType } from "../key-pool.js";
import { kernels } from "../cljs-kernels.js";
import type { CredentialProviderView } from "../credential-store.js";

export interface SqlOpenAiAccountIdentityRow {
  readonly id: string;
  readonly provider_id: string;
  readonly chatgpt_account_id: string | null;
}

export function selectLegacyOpenAiDuplicateIds(rows: readonly SqlOpenAiAccountIdentityRow[]): string[] {
  return kernels.legacyOpenAiDuplicateIds(rows);
}

export interface SqlCredentialStoreStatus {
  initialized: boolean;
  tenantCount: number;
  providerCount: number;
  totalAccountCount: number;
}

export interface TenantView {
  id: string;
  name: string;
  status: string;
}

export type TenantMembershipRole = "owner" | "admin" | "member" | "viewer";

export interface UserView {
  id: string;
  provider: string;
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface TenantMembershipView {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  role: TenantMembershipRole;
}

export interface ResolvedUiSession {
  userId: string;
  subject: string;
  activeTenantId: string;
  role: TenantMembershipRole;
  memberships: readonly TenantMembershipView[];
}

export interface TenantApiKeyMatch {
  id: string;
  tenantId: string;
  label: string;
  prefix: string;
  scopes: readonly string[];
}

export interface TenantApiKeyView {
  id: string;
  tenantId: string;
  label: string;
  prefix: string;
  scopes: readonly string[];
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedTenantApiKey {
  id: string;
  tenantId: string;
  label: string;
  prefix: string;
  token: string;
  scopes: readonly string[];
}

interface SqlCredentialStoreKernel {
  init(): Promise<void>;
  getStatus(): Promise<SqlCredentialStoreStatus>;
  listTenants(): Promise<TenantView[]>;
  upsertUser(input: UpsertUserInput): Promise<UserView>;
  getUserBySubject(subject: string): Promise<UserView | undefined>;
  listUserMemberships(userId: string): Promise<TenantMembershipView[]>;
  ensureTenantMembership(userId: string, tenantId: string, role: TenantMembershipRole): Promise<void>;
  ensureDefaultTenantBootstrapMembership(userId: string): Promise<TenantMembershipRole>;
  resolveUiSession(subject: string, activeTenantId?: string): Promise<ResolvedUiSession | undefined>;
  resolveTenantApiKey(token: string, pepper: string): Promise<TenantApiKeyMatch | undefined>;
  listTenantApiKeys(tenantId: string): Promise<TenantApiKeyView[]>;
  createTenantApiKey(tenantId: string, label: string, scopes: readonly string[], pepper: string): Promise<CreatedTenantApiKey>;
  revokeTenantApiKey(tenantId: string, keyId: string): Promise<boolean>;
  touchTenantApiKeyLastUsed(tenantId: string, keyId: string): Promise<void>;
  listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]>;
  getAllProviders(): Promise<Map<string, { authType: ProviderAuthType }>>;
  getAccountsByProvider(providerId: string): Promise<ProviderCredential[]>;
  getAllAccounts(): Promise<Map<string, ProviderCredential[]>>;
  cleanupLegacyOpenAiDuplicates(chatgptAccountId?: string): Promise<number>;
  upsertProvider(providerId: string, authType: ProviderAuthType): Promise<void>;
  upsertProviderWithBaseUrl(providerId: string, authType: ProviderAuthType, baseUrl: string): Promise<void>;
  getProviderById(providerId: string): Promise<{ id: string; authType: ProviderAuthType; baseUrl: string | null } | null>;
  listProvidersWithBaseUrlByPrefix(prefix: string): Promise<readonly { readonly id: string; readonly baseUrl: string }[]>;
  upsertAccount(account: ProviderCredential): Promise<void>;
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
  upsertAccounts(accounts: readonly ProviderCredential[]): Promise<void>;
  deleteAccount(providerId: string, accountId: string): Promise<void>;
  removeAccount(providerId: string, accountId: string): Promise<boolean>;
  setCooldown(providerId: string, accountId: string, cooldownUntil: number): void;
  getCooldown(providerId: string, accountId: string): number | undefined;
  persistCooldown(providerId: string, accountId: string, cooldownUntil: number): Promise<void>;
  clearCooldown(providerId: string, accountId: string): Promise<void>;
  loadCooldowns(): Promise<Map<string, number>>;
  loadDisabledAccounts(): Promise<Set<string>>;
  setAccountDisabled(providerId: string, accountId: string, disabled: boolean): Promise<void>;
  loadAccountsIntoKeyPool(
    keyPool: { updateAccountCredential(providerId: string, old: ProviderCredential, updated: ProviderCredential): void },
    defaultProviderId: string,
  ): Promise<void>;
}

interface UpsertUserInput {
  provider: string;
  subject: string;
  login?: string | null;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

/**
 * Tenants, users, API keys, providers, accounts and cooldowns in Postgres.
 * Row mapping and statement composition are proxx.credentials.sql; execution and
 * the cooldown cache are proxx.runtime.sql-credential-store. This class keeps
 * the names and types callers already use.
 */
export class SqlCredentialStore {
  private readonly impl: SqlCredentialStoreKernel;

  public constructor(
    sql: Sql,
    options: {
      readonly defaultTenantId?: string;
    } = {},
  ) {
    this.impl = kernels.createSqlCredentialStore(sql, options) as SqlCredentialStoreKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public getStatus(): Promise<SqlCredentialStoreStatus> {
    return this.impl.getStatus();
  }

  public listTenants(): Promise<TenantView[]> {
    return this.impl.listTenants();
  }

  public upsertUser(input: UpsertUserInput): Promise<UserView> {
    return this.impl.upsertUser(input);
  }

  public getUserBySubject(subject: string): Promise<UserView | undefined> {
    return this.impl.getUserBySubject(subject);
  }

  public listUserMemberships(userId: string): Promise<TenantMembershipView[]> {
    return this.impl.listUserMemberships(userId);
  }

  public ensureTenantMembership(userId: string, tenantId: string, role: TenantMembershipRole): Promise<void> {
    return this.impl.ensureTenantMembership(userId, tenantId, role);
  }

  public ensureDefaultTenantBootstrapMembership(userId: string): Promise<TenantMembershipRole> {
    return this.impl.ensureDefaultTenantBootstrapMembership(userId);
  }

  public resolveUiSession(subject: string, activeTenantId?: string): Promise<ResolvedUiSession | undefined> {
    return this.impl.resolveUiSession(subject, activeTenantId);
  }

  public resolveTenantApiKey(token: string, pepper: string): Promise<TenantApiKeyMatch | undefined> {
    return this.impl.resolveTenantApiKey(token, pepper);
  }

  public listTenantApiKeys(tenantId: string): Promise<TenantApiKeyView[]> {
    return this.impl.listTenantApiKeys(tenantId);
  }

  public createTenantApiKey(tenantId: string, label: string, scopes: readonly string[], pepper: string): Promise<CreatedTenantApiKey> {
    return this.impl.createTenantApiKey(tenantId, label, scopes, pepper);
  }

  public revokeTenantApiKey(tenantId: string, keyId: string): Promise<boolean> {
    return this.impl.revokeTenantApiKey(tenantId, keyId);
  }

  public touchTenantApiKeyLastUsed(tenantId: string, keyId: string): Promise<void> {
    return this.impl.touchTenantApiKeyLastUsed(tenantId, keyId);
  }

  public listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    return this.impl.listProviders(revealSecrets);
  }

  public getAllProviders(): Promise<Map<string, { authType: ProviderAuthType }>> {
    return this.impl.getAllProviders();
  }

  public getAccountsByProvider(providerId: string): Promise<ProviderCredential[]> {
    return this.impl.getAccountsByProvider(providerId);
  }

  public getAllAccounts(): Promise<Map<string, ProviderCredential[]>> {
    return this.impl.getAllAccounts();
  }

  public cleanupLegacyOpenAiDuplicates(chatgptAccountId?: string): Promise<number> {
    return this.impl.cleanupLegacyOpenAiDuplicates(chatgptAccountId);
  }

  public upsertProvider(providerId: string, authType: ProviderAuthType): Promise<void> {
    return this.impl.upsertProvider(providerId, authType);
  }

  public upsertProviderWithBaseUrl(providerId: string, authType: ProviderAuthType, baseUrl: string): Promise<void> {
    return this.impl.upsertProviderWithBaseUrl(providerId, authType, baseUrl);
  }

  public getProviderById(providerId: string): Promise<{ id: string; authType: ProviderAuthType; baseUrl: string | null } | null> {
    return this.impl.getProviderById(providerId);
  }

  public listProvidersWithBaseUrlByPrefix(prefix: string): Promise<readonly { readonly id: string; readonly baseUrl: string }[]> {
    return this.impl.listProvidersWithBaseUrlByPrefix(prefix);
  }

  public upsertAccount(account: ProviderCredential): Promise<void> {
    return this.impl.upsertAccount(account);
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

  public upsertAccounts(accounts: readonly ProviderCredential[]): Promise<void> {
    return this.impl.upsertAccounts(accounts);
  }

  public deleteAccount(providerId: string, accountId: string): Promise<void> {
    return this.impl.deleteAccount(providerId, accountId);
  }

  public removeAccount(providerId: string, accountId: string): Promise<boolean> {
    return this.impl.removeAccount(providerId, accountId);
  }

  public setCooldown(providerId: string, accountId: string, cooldownUntil: number): void {
    this.impl.setCooldown(providerId, accountId, cooldownUntil);
  }

  public getCooldown(providerId: string, accountId: string): number | undefined {
    return this.impl.getCooldown(providerId, accountId);
  }

  public persistCooldown(providerId: string, accountId: string, cooldownUntil: number): Promise<void> {
    return this.impl.persistCooldown(providerId, accountId, cooldownUntil);
  }

  public clearCooldown(providerId: string, accountId: string): Promise<void> {
    return this.impl.clearCooldown(providerId, accountId);
  }

  public loadCooldowns(): Promise<Map<string, number>> {
    return this.impl.loadCooldowns();
  }

  public loadDisabledAccounts(): Promise<Set<string>> {
    return this.impl.loadDisabledAccounts();
  }

  public setAccountDisabled(providerId: string, accountId: string, disabled: boolean): Promise<void> {
    return this.impl.setAccountDisabled(providerId, accountId, disabled);
  }

  public loadAccountsIntoKeyPool(
    keyPool: {
      updateAccountCredential(providerId: string, old: ProviderCredential, updated: ProviderCredential): void;
    },
    defaultProviderId: string,
  ): Promise<void> {
    return this.impl.loadAccountsIntoKeyPool(keyPool, defaultProviderId);
  }
}
