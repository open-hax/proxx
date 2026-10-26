import crypto from "node:crypto";

import type { Sql } from "./index.js";
import type { ProviderCredential, ProviderAuthType } from "../key-pool.js";
import { deriveOAuthMetadataFromToken } from "../account-identity.js";
import { kernels } from "../cljs-kernels.js";
import { DEFAULT_TENANT_ID, buildTenantApiKeyPrefix, generateTenantApiKey, hashTenantApiKey, normalizeTenantId } from "../tenant-api-key.js";
import type { CredentialProviderView } from "../credential-store.js";
import {
  UPSERT_PROVIDER,
  UPSERT_PROVIDER_WITH_BASE_URL,
  SELECT_PROVIDER_BY_ID,
  UPSERT_TENANT,
  UPSERT_USER,
  SELECT_USER_BY_SUBJECT,
  UPSERT_TENANT_MEMBERSHIP,
  SELECT_TENANT_MEMBERSHIPS_BY_USER,
  COUNT_TENANT_MEMBERSHIPS_FOR_TENANT,
  INSERT_ACCOUNT,
  INSERT_TENANT_API_KEY,
  SELECT_ACTIVE_TENANT_API_KEY_BY_HASH,
  SELECT_ALL_TENANTS,
  SELECT_TENANT_API_KEYS_BY_TENANT,
  SELECT_ALL_PROVIDERS,
  SELECT_ACCOUNTS_BY_PROVIDER,
  SELECT_ALL_ACCOUNTS,
  DELETE_ACCOUNT,
  REVOKE_TENANT_API_KEY,
  TOUCH_TENANT_API_KEY_LAST_USED,
  SET_COOLDOWN,
  CLEAR_EXPIRED_COOLDOWNS,
  SELECT_ALL_ACTIVE_COOLDOWNS,
  SET_ACCOUNT_DISABLED,
  SELECT_ALL_DISABLED_ACCOUNTS,
} from "./schema.js";

interface ProviderRow {
  id: string;
  auth_type: string;
  base_url: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
}

interface UserRow {
  id: string;
  provider: string;
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

interface TenantMembershipRow {
  tenant_id: string;
  role: string;
  tenant_name: string;
  tenant_status: string;
}

interface TenantApiKeyRow {
  id: string;
  tenant_id: string;
  label: string;
  prefix: string;
  scopes: string[] | string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  revoked_at: string | null;
}

interface AccountRow {
  id: string;
  provider_id: string;
  token: string;
  refresh_token: string | null;
  expires_at: number | null;
  chatgpt_account_id: string | null;
  plan_type: string | null;
  disabled: boolean | null;
}

export interface SqlOpenAiAccountIdentityRow {
  readonly id: string;
  readonly provider_id: string;
  readonly chatgpt_account_id: string | null;
}

function normalizeAuthType(raw: string): ProviderAuthType {
  return kernels.normalizeAuthTypeSql(raw);
}

function toProviderCredential(row: AccountRow, authType: ProviderAuthType): ProviderCredential {
  return kernels.sqlProviderCredential(row, authType) as unknown as ProviderCredential;
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

function toUserView(row: UserRow): UserView {
  return kernels.sqlUserView(row) as unknown as UserView;
}

function toTenantMembershipView(row: TenantMembershipRow): TenantMembershipView {
  return kernels.sqlMembershipView(row) as unknown as TenantMembershipView;
}

export class SqlCredentialStore {
  private initialized = false;
  private readonly cooldowns = new Map<string, number>();

  public constructor(
    private readonly sql: Sql,
    private readonly options: {
      readonly defaultTenantId?: string;
    } = {},
  ) {}

  public async init(): Promise<void> {
    await this.runMigrations();
    this.initialized = true;
  }

  private async runMigrations(): Promise<void> {
    // The migrations are data (resources/db/schema.edn); proxx.db.schema plans them and
    // proxx.runtime.db-schema runs them. Every one is idempotent (CREATE TABLE IF NOT EXISTS /
    // ALTER TABLE ADD COLUMN IF NOT EXISTS), so all of them re-run on every startup, then the
    // declared schema version is recorded if absent.
    await kernels.runMigrations(this.sql);

    await this.ensureDefaultTenant();
  }

  private async ensureDefaultTenant(): Promise<void> {
    const tenantId = normalizeTenantId(this.options.defaultTenantId ?? DEFAULT_TENANT_ID);
    await this.sql.unsafe(UPSERT_TENANT, [tenantId, tenantId, "active"]);
  }

  public async getStatus(): Promise<SqlCredentialStoreStatus> {
    const tenants = await this.sql.unsafe<TenantRow[]>(SELECT_ALL_TENANTS);
    const providers = await this.sql.unsafe<ProviderRow[]>(SELECT_ALL_PROVIDERS);
    const accounts = await this.sql.unsafe<AccountRow[]>(SELECT_ALL_ACCOUNTS);

    return {
      initialized: this.initialized,
      tenantCount: tenants.length,
      providerCount: providers.length,
      totalAccountCount: accounts.length,
    };
  }

  public async listTenants(): Promise<TenantView[]> {
    const rows = await this.sql.unsafe<TenantRow[]>(SELECT_ALL_TENANTS);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
    }));
  }

  public async upsertUser(input: {
    provider: string;
    subject: string;
    login?: string | null;
    email?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
  }): Promise<UserView> {
    const params = kernels.sqlUserUpsertParams(() => crypto.randomUUID(), input);
    const rows = await this.sql.unsafe<UserRow[]>(UPSERT_USER, params as never[]);
    const row = rows[0];
    if (!row) {
      throw new Error("failed to upsert user");
    }

    return toUserView(row);
  }

  public async getUserBySubject(subject: string): Promise<UserView | undefined> {
    const normalizedSubject = subject.trim().toLowerCase();
    if (normalizedSubject.length === 0) {
      return undefined;
    }

    const rows = await this.sql.unsafe<UserRow[]>(SELECT_USER_BY_SUBJECT, [normalizedSubject]);
    const row = rows[0];
    return row ? toUserView(row) : undefined;
  }

  public async listUserMemberships(userId: string): Promise<TenantMembershipView[]> {
    const rows = await this.sql.unsafe<TenantMembershipRow[]>(SELECT_TENANT_MEMBERSHIPS_BY_USER, [userId]);
    return rows.map(toTenantMembershipView);
  }

  public async ensureTenantMembership(userId: string, tenantId: string, role: TenantMembershipRole): Promise<void> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    await this.sql.unsafe(UPSERT_TENANT_MEMBERSHIP, [normalizedTenantId, userId, role]);
  }

  public async ensureDefaultTenantBootstrapMembership(userId: string): Promise<TenantMembershipRole> {
    const existingMemberships = await this.listUserMemberships(userId);
    const hasDefault = existingMemberships.some((membership) => membership.tenantId === DEFAULT_TENANT_ID);
    const rows = hasDefault
      ? []
      : await this.sql.unsafe<Array<{ count: string | number }>>(COUNT_TENANT_MEMBERSHIPS_FOR_TENANT, [DEFAULT_TENANT_ID]);
    const plan = kernels.sqlBootstrapRole(existingMemberships, DEFAULT_TENANT_ID, rows[0] ?? {});
    const role = plan.role as TenantMembershipRole;
    if (plan.create) {
      await this.ensureTenantMembership(userId, DEFAULT_TENANT_ID, role);
    }
    return role;
  }

  public async resolveUiSession(subject: string, activeTenantId?: string): Promise<ResolvedUiSession | undefined> {
    const user = await this.getUserBySubject(subject);
    if (!user) {
      return undefined;
    }

    const memberships = await this.listUserMemberships(user.id);
    if (memberships.length === 0) {
      return undefined;
    }

    const normalizedActiveTenantId = typeof activeTenantId === "string" && activeTenantId.trim().length > 0
      ? normalizeTenantId(activeTenantId)
      : undefined;
    return (kernels.sqlResolveUiSession(user, memberships, normalizedActiveTenantId, DEFAULT_TENANT_ID) ?? undefined) as ResolvedUiSession | undefined;
  }

  public async resolveTenantApiKey(token: string, pepper: string): Promise<TenantApiKeyMatch | undefined> {
    const tokenHash = hashTenantApiKey(token, pepper);
    const rows = await this.sql.unsafe<TenantApiKeyRow[]>(SELECT_ACTIVE_TENANT_API_KEY_BY_HASH, [tokenHash]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return kernels.sqlTenantApiKeyMatch(row) as unknown as TenantApiKeyMatch;
  }

  public async listTenantApiKeys(tenantId: string): Promise<TenantApiKeyView[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const rows = await this.sql.unsafe<TenantApiKeyRow[]>(SELECT_TENANT_API_KEYS_BY_TENANT, [normalizedTenantId]);
    return rows.map((row) => kernels.sqlTenantApiKeyView(row) as unknown as TenantApiKeyView);
  }

  public async createTenantApiKey(tenantId: string, label: string, scopes: readonly string[], pepper: string): Promise<CreatedTenantApiKey> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedLabel = kernels.sqlNormalizedApiKeyLabel(label);

    const token = generateTenantApiKey();
    const id = crypto.randomUUID();
    const prefix = buildTenantApiKeyPrefix(token);
    const tokenHash = hashTenantApiKey(token, pepper);
    const storedScopes = kernels.sqlApiKeyScopes(scopes);

    await this.sql.unsafe(INSERT_TENANT_API_KEY, [
      id,
      normalizedTenantId,
      normalizedLabel,
      prefix,
      tokenHash,
      JSON.stringify(storedScopes),
    ]);

    return {
      id,
      tenantId: normalizedTenantId,
      label: normalizedLabel,
      prefix,
      token,
      scopes: storedScopes,
    };
  }

  public async revokeTenantApiKey(tenantId: string, keyId: string): Promise<boolean> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const result = await this.sql.unsafe<Array<{ id: string }>>(
      `${REVOKE_TENANT_API_KEY} RETURNING id`,
      [normalizedTenantId, keyId],
    );
    return result.length > 0;
  }

  public async touchTenantApiKeyLastUsed(tenantId: string, keyId: string): Promise<void> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    await this.sql.unsafe(TOUCH_TENANT_API_KEY_LAST_USED, [normalizedTenantId, keyId]);
  }

  public async listProviders(revealSecrets: boolean): Promise<CredentialProviderView[]> {
    const providerRows = await this.sql.unsafe<ProviderRow[]>(SELECT_ALL_PROVIDERS);
    const accountRows = await this.sql.unsafe<AccountRow[]>(SELECT_ALL_ACCOUNTS);
    return kernels.sqlCredentialProviderViews(providerRows, accountRows, revealSecrets, deriveOAuthMetadataFromToken)
      .sort((left, right) => (left as CredentialProviderView).id.localeCompare((right as CredentialProviderView).id)) as CredentialProviderView[];
  }

  public async getAllProviders(): Promise<Map<string, { authType: ProviderAuthType }>> {
    const rows = await this.sql.unsafe<ProviderRow[]>(SELECT_ALL_PROVIDERS);
    const result = new Map<string, { authType: ProviderAuthType }>();
    for (const row of rows) {
      result.set(row.id, { authType: normalizeAuthType(row.auth_type) });
    }
    return result;
  }

  public async getAccountsByProvider(providerId: string): Promise<ProviderCredential[]> {
    const rows = await this.sql.unsafe<AccountRow[]>(SELECT_ACCOUNTS_BY_PROVIDER, [providerId]);
    const providers = await this.getAllProviders();
    const authType = providers.get(providerId)?.authType ?? "api_key";
    return rows.map((row) => toProviderCredential(row, authType));
  }

  private inferAuthType(_token: string): ProviderAuthType {
    return "api_key";
  }

  public async getAllAccounts(): Promise<Map<string, ProviderCredential[]>> {
    const providers = await this.getAllProviders();
    const rows = await this.sql.unsafe<AccountRow[]>(SELECT_ALL_ACCOUNTS);
    const result = new Map<string, ProviderCredential[]>();

    for (const row of rows) {
      const accounts = result.get(row.provider_id) ?? [];
      const authType = providers.get(row.provider_id)?.authType ?? this.inferAuthType(row.token);
      accounts.push(toProviderCredential(row, authType));
      result.set(row.provider_id, accounts);
    }

    return result;
  }

  public async cleanupLegacyOpenAiDuplicates(chatgptAccountId?: string): Promise<number> {
    const rows = chatgptAccountId
      ? await this.sql.unsafe<AccountRow[]>(
        `${SELECT_ACCOUNTS_BY_PROVIDER.replace("ORDER BY id;", "AND chatgpt_account_id = $2 ORDER BY id;")}`,
        ["openai", chatgptAccountId],
      )
      : await this.sql.unsafe<AccountRow[]>(SELECT_ACCOUNTS_BY_PROVIDER, ["openai"]);
    const idsToDelete = selectLegacyOpenAiDuplicateIds(rows);

    if (idsToDelete.length === 0) {
      return 0;
    }

    await this.sql.begin(async (tx) => {
      await tx.unsafe(
        "DELETE FROM account_cooldown WHERE provider_id = 'openai' AND account_id = ANY($1::text[])",
        [idsToDelete],
      );
      await tx.unsafe(
        "DELETE FROM account_health WHERE provider_id = 'openai' AND account_id = ANY($1::text[])",
        [idsToDelete],
      );
      await tx.unsafe(
        "DELETE FROM accounts WHERE provider_id = 'openai' AND id = ANY($1::text[])",
        [idsToDelete],
      );
    });

    return idsToDelete.length;
  }

  public async upsertProvider(providerId: string, authType: ProviderAuthType): Promise<void> {
    await this.sql.unsafe(UPSERT_PROVIDER, [providerId, authType, null]);
  }

  public async upsertProviderWithBaseUrl(providerId: string, authType: ProviderAuthType, baseUrl: string): Promise<void> {
    await this.sql.unsafe(UPSERT_PROVIDER_WITH_BASE_URL, [providerId, authType, baseUrl]);
  }

  public async getProviderById(providerId: string): Promise<{ id: string; authType: ProviderAuthType; baseUrl: string | null } | null> {
    const rows = await this.sql.unsafe<ProviderRow[]>(SELECT_PROVIDER_BY_ID, [providerId]);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0]!;
    return {
      id: row.id,
      authType: normalizeAuthType(row.auth_type),
      baseUrl: row.base_url,
    };
  }

  public async listProvidersWithBaseUrlByPrefix(prefix: string): Promise<readonly { readonly id: string; readonly baseUrl: string }[]> {
    const rows = await this.sql.unsafe<ProviderRow[]>(
      `SELECT id, auth_type, base_url FROM providers WHERE id LIKE $1 AND base_url IS NOT NULL AND base_url != ''`,
      [`${prefix}%`],
    );
    return rows.map((row) => ({ id: row.id, baseUrl: row.base_url! }));
  }

  public async upsertAccount(account: ProviderCredential): Promise<void> {
    await this.upsertProvider(account.providerId, account.authType);
    await this.sql.unsafe(INSERT_ACCOUNT, [
      account.accountId,
      account.providerId,
      account.token,
      account.refreshToken ?? null,
      account.expiresAt ?? null,
      account.chatgptAccountId ?? null,
      account.planType ?? null,
    ]);
  }

  public async upsertApiKeyAccount(providerId: string, accountId: string, apiKey: string): Promise<void> {
    await this.upsertAccount({
      providerId,
      accountId,
      token: apiKey,
      authType: "api_key",
    });
  }

  public async upsertOAuthAccount(
    providerId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: number,
    chatgptAccountId?: string,
    _email?: string,
    _subject?: string,
    planType?: string,
  ): Promise<void> {
    await this.upsertAccount({
      providerId,
      accountId,
      token: accessToken,
      authType: "oauth_bearer",
      refreshToken,
      expiresAt,
      chatgptAccountId,
      planType,
    });

    if (providerId === "openai" && chatgptAccountId) {
      await this.cleanupLegacyOpenAiDuplicates(chatgptAccountId);
    }
  }

  public async upsertAccounts(accounts: readonly ProviderCredential[]): Promise<void> {
    for (const account of accounts) {
      await this.upsertAccount(account);
    }
  }

  public async deleteAccount(providerId: string, accountId: string): Promise<void> {
    await this.sql.unsafe(DELETE_ACCOUNT, [accountId, providerId]);
  }

  public async removeAccount(providerId: string, accountId: string): Promise<boolean> {
    const deleted = await this.sql.begin(async (tx) => {
      const deleted = await tx.unsafe<Array<{ readonly id: string }>>(
        "DELETE FROM accounts WHERE id = $1 AND provider_id = $2 RETURNING id",
        [accountId, providerId],
      );

      await tx.unsafe(
        "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2",
        [providerId, accountId],
      );
      await tx.unsafe(
        "DELETE FROM account_health WHERE provider_id = $1 AND account_id = $2",
        [providerId, accountId],
      );

      return deleted;
    });

    // Only mutate in-memory state after the transaction commits.
    this.cooldowns.delete(`${providerId}:${accountId}`);
    return deleted.length > 0;
  }

  public setCooldown(providerId: string, accountId: string, cooldownUntil: number): void {
    this.cooldowns.set(`${providerId}:${accountId}`, cooldownUntil);
  }

  public getCooldown(providerId: string, accountId: string): number | undefined {
    return this.cooldowns.get(`${providerId}:${accountId}`);
  }

  public async persistCooldown(providerId: string, accountId: string, cooldownUntil: number): Promise<void> {
    await this.sql.unsafe(SET_COOLDOWN, [providerId, accountId, cooldownUntil]);
    this.cooldowns.set(`${providerId}:${accountId}`, cooldownUntil);
  }

  public async clearCooldown(providerId: string, accountId: string): Promise<void> {
    await this.sql.unsafe(
      "DELETE FROM account_cooldown WHERE provider_id = $1 AND account_id = $2",
      [providerId, accountId],
    );
    this.cooldowns.delete(`${providerId}:${accountId}`);
  }

  public async loadCooldowns(): Promise<Map<string, number>> {
    const now = Date.now();
    await this.sql.unsafe(CLEAR_EXPIRED_COOLDOWNS, [now]);

    const rows = await this.sql.unsafe<Array<{ provider_id: string; account_id: string; cooldown_until: number | string }>>(
      SELECT_ALL_ACTIVE_COOLDOWNS,
      [now],
    );

    this.cooldowns.clear();
    const result = new Map<string, number>();
    for (const [providerId, accountId, cooldownUntil] of kernels.sqlCooldownEntries(rows)) {
      result.set(`${providerId}\0${accountId}`, cooldownUntil);
      this.cooldowns.set(`${providerId}:${accountId}`, cooldownUntil);
    }
    return result;
  }

  public async loadDisabledAccounts(): Promise<Set<string>> {
    const rows = await this.sql.unsafe<Array<{ id: string; provider_id: string }>>(
      SELECT_ALL_DISABLED_ACCOUNTS,
    );
    const result = new Set<string>();
    for (const row of rows) {
      result.add(`${row.provider_id}\0${row.id}`);
    }
    return result;
  }

  public async setAccountDisabled(providerId: string, accountId: string, disabled: boolean): Promise<void> {
    await this.sql.unsafe(SET_ACCOUNT_DISABLED, [accountId, providerId, disabled]);
  }

  public async loadAccountsIntoKeyPool(
    keyPool: {
      updateAccountCredential(providerId: string, old: ProviderCredential, updated: ProviderCredential): void;
    },
    defaultProviderId: string,
  ): Promise<void> {
    const accountsByProvider = await this.getAllAccounts();

    for (const [providerId, accounts] of accountsByProvider) {
      for (const account of accounts) {
        keyPool.updateAccountCredential(providerId, account, account);
      }
    }

    if (!accountsByProvider.has(defaultProviderId)) {
      accountsByProvider.set(defaultProviderId, []);
    }
  }
}
