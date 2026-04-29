import type { Sql } from "./index.js";
import {
  SELECT_ALL_PROMPT_AFFINITY,
  UPSERT_PROMPT_AFFINITY,
  DELETE_PROMPT_AFFINITY,
  UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL,
} from "./schema.js";

export interface IPromptAffinityStore {
  init?(): Promise<void>;
  warmup?(): Promise<void>;
  close(): Promise<void>;
  get(promptCacheKey: string): Promise<PromptAffinityRecord | undefined>;
  upsert(promptCacheKey: string, providerId: string, accountId: string): Promise<void>;
  noteSuccess(promptCacheKey: string, providerId: string, accountId: string): Promise<void>;
  delete(promptCacheKey: string): Promise<void>;
}

export interface PromptAffinityRecord {
  readonly promptCacheKey: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly provisionalProviderId?: string;
  readonly provisionalAccountId?: string;
  readonly provisionalSuccessCount?: number;
  readonly updatedAt: number;
}

const PROVISIONAL_PROMOTION_SUCCESS_COUNT = 2;

interface AffinityRow {
  prompt_cache_key: string;
  provider_id: string;
  account_id: string;
  provisional_provider_id: string | null;
  provisional_account_id: string | null;
  provisional_success_count: number;
  updated_at: number;
}

function rowToRecord(row: AffinityRow): PromptAffinityRecord {
  return {
    promptCacheKey: row.prompt_cache_key,
    providerId: row.provider_id,
    accountId: row.account_id,
    provisionalProviderId: row.provisional_provider_id ?? undefined,
    provisionalAccountId: row.provisional_account_id ?? undefined,
    provisionalSuccessCount: row.provisional_success_count > 0 ? row.provisional_success_count : undefined,
    updatedAt: row.updated_at,
  };
}

export class SqlPromptAffinityStore {
  private cache = new Map<string, PromptAffinityRecord>();
  private initialized = false;

  public constructor(private readonly sql: Sql | undefined) {}

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.sql) {
      try {
        const rows = await this.sql.unsafe<AffinityRow[]>(SELECT_ALL_PROMPT_AFFINITY);
        for (const row of rows) {
          this.cache.set(row.prompt_cache_key, rowToRecord(row));
        }
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e
          ? (e as { readonly code?: unknown }).code
          : undefined;
        if (code === "42P01") {
          // prompt_affinity table does not exist yet
        } else {
          throw e;
        }
      }
    }
    this.initialized = true;
  }

  public async get(promptCacheKey: string): Promise<PromptAffinityRecord | undefined> {
    const normalized = promptCacheKey.trim();
    if (!normalized) return undefined;
    return this.cache.get(normalized);
  }

  public async upsert(promptCacheKey: string, providerId: string, accountId: string): Promise<void> {
    const normalizedKey = promptCacheKey.trim();
    if (!normalizedKey) return;
    const now = Date.now();
    if (this.sql) {
      await this.sql.unsafe(UPSERT_PROMPT_AFFINITY, [
        normalizedKey,
        providerId.trim(),
        accountId.trim(),
        null,
        null,
        0,
        now,
      ]);
    }
    this.cache.set(normalizedKey, {
      promptCacheKey: normalizedKey,
      providerId: providerId.trim(),
      accountId: accountId.trim(),
      updatedAt: now,
    });
  }

  private async persistUpsert(
    normalizedKey: string,
    providerId: string,
    accountId: string,
    provisionalProviderId: string | null,
    provisionalAccountId: string | null,
    provisionalSuccessCount: number,
    now: number,
  ): Promise<void> {
    if (this.sql) {
      await this.sql.unsafe(UPSERT_PROMPT_AFFINITY, [
        normalizedKey,
        providerId,
        accountId,
        provisionalProviderId,
        provisionalAccountId,
        provisionalSuccessCount,
        now,
      ]);
    }
  }

  private async persistPromoteProvisional(
    normalizedKey: string,
    providerId: string,
    accountId: string,
    now: number,
  ): Promise<void> {
    if (this.sql) {
      await this.sql.unsafe(UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL, [
        normalizedKey,
        providerId,
        accountId,
        now,
      ]);
    }
  }

  public async noteSuccess(promptCacheKey: string, providerId: string, accountId: string): Promise<void> {
    const normalizedKey = promptCacheKey.trim();
    const normalizedProviderId = providerId.trim();
    const normalizedAccountId = accountId.trim();
    if (!normalizedKey || !normalizedProviderId || !normalizedAccountId) return;

    const now = Date.now();
    const existing = this.cache.get(normalizedKey);

    if (!existing) {
      await this.persistUpsert(normalizedKey, normalizedProviderId, normalizedAccountId, null, null, 0, now);
      this.cache.set(normalizedKey, {
        promptCacheKey: normalizedKey,
        providerId: normalizedProviderId,
        accountId: normalizedAccountId,
        updatedAt: now,
      });
      return;
    }

    if (existing.providerId === normalizedProviderId && existing.accountId === normalizedAccountId) {
      await this.persistUpsert(normalizedKey, normalizedProviderId, normalizedAccountId, null, null, 0, now);
      this.cache.set(normalizedKey, {
        promptCacheKey: normalizedKey,
        providerId: normalizedProviderId,
        accountId: normalizedAccountId,
        updatedAt: now,
      });
      return;
    }

    const sameProvisional =
      existing.provisionalProviderId === normalizedProviderId
      && existing.provisionalAccountId === normalizedAccountId;
    const provisionalSuccessCount = sameProvisional
      ? (existing.provisionalSuccessCount ?? 1) + 1
      : 1;

    if (provisionalSuccessCount >= PROVISIONAL_PROMOTION_SUCCESS_COUNT) {
      await this.persistPromoteProvisional(normalizedKey, normalizedProviderId, normalizedAccountId, now);
      this.cache.set(normalizedKey, {
        promptCacheKey: normalizedKey,
        providerId: normalizedProviderId,
        accountId: normalizedAccountId,
        updatedAt: now,
      });
    } else {
      await this.persistUpsert(
        normalizedKey,
        existing.providerId,
        existing.accountId,
        normalizedProviderId,
        normalizedAccountId,
        provisionalSuccessCount,
        now,
      );
      this.cache.set(normalizedKey, {
        ...existing,
        provisionalProviderId: normalizedProviderId,
        provisionalAccountId: normalizedAccountId,
        provisionalSuccessCount,
        updatedAt: now,
      });
    }
  }

  public async close(): Promise<void> {}

  public async delete(promptCacheKey: string): Promise<void> {
    const normalized = promptCacheKey.trim();
    if (!normalized) return;
    if (this.sql) {
      await this.sql.unsafe(DELETE_PROMPT_AFFINITY, [normalized]);
    }
    this.cache.delete(normalized);
  }
}
