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
