import type { Sql } from "./index.js";
import { kernels } from "../cljs-kernels.js";
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

/**
 * Prompt-affinity pins. The record transition and the choice of statement are
 * CLJS (`proxx.credentials.affinity`); cache and database are its edge
 * (`proxx.runtime.prompt-affinity`).
 */
export class SqlPromptAffinityStore implements IPromptAffinityStore {
  private readonly impl: IPromptAffinityStore & { init(): Promise<void> };

  public constructor(sql: Sql | undefined) {
    this.impl = kernels.createPromptAffinityStore(sql, {
      selectAll: SELECT_ALL_PROMPT_AFFINITY,
      upsert: UPSERT_PROMPT_AFFINITY,
      delete: DELETE_PROMPT_AFFINITY,
      promote: UPSERT_PROMPT_AFFINITY_PROMOTE_PROVISIONAL,
    }) as IPromptAffinityStore & { init(): Promise<void> };
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public get(promptCacheKey: string): Promise<PromptAffinityRecord | undefined> {
    return this.impl.get(promptCacheKey).then((record) => record ?? undefined);
  }

  public upsert(promptCacheKey: string, providerId: string, accountId: string): Promise<void> {
    return this.impl.upsert(promptCacheKey, providerId, accountId);
  }

  public noteSuccess(promptCacheKey: string, providerId: string, accountId: string): Promise<void> {
    return this.impl.noteSuccess(promptCacheKey, providerId, accountId);
  }

  public close(): Promise<void> {
    return this.impl.close();
  }

  public delete(promptCacheKey: string): Promise<void> {
    return this.impl.delete(promptCacheKey);
  }
}
