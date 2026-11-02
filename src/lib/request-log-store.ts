import { kernels } from "./cljs-kernels.js";
import { estimateRequestCost } from "./model-pricing.js";

export type RequestAuthType = "api_key" | "oauth_bearer" | "local" | "none";
export type RequestServiceTierSource = "fast_mode" | "explicit" | "none";
export type RequestRouteKind = "local" | "federated" | "bridge";

export interface Factory4xxDiagnostics {
  readonly promptCacheKeyHash?: string;
  readonly requestFormat: "responses" | "messages" | "chat_completions" | "unknown";
  readonly shapeFingerprint?: string;
  readonly messageCount?: number;
  readonly inputItemCount?: number;
  readonly systemMessageCount?: number;
  readonly userMessageCount?: number;
  readonly assistantMessageCount?: number;
  readonly toolMessageCount?: number;
  readonly functionCallCount?: number;
  readonly functionCallOutputCount?: number;
  readonly imageInputCount?: number;
  readonly hasInstructions?: boolean;
  readonly instructionsChars?: number;
  readonly totalTextChars?: number;
  readonly maxTextBlockChars?: number;
  readonly hasReasoning?: boolean;
  readonly hasCodeFence?: boolean;
  readonly hasXmlLikeTags?: boolean;
  readonly hasOpencodeMarkers?: boolean;
  readonly hasAgentProtocolMarkers?: boolean;
  readonly textFingerprint?: string;
  readonly instructionsFingerprint?: string;
}

export interface RequestLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly routeKind: RequestRouteKind;
  readonly federationOwnerSubject?: string;
  readonly routedPeerId?: string;
  readonly routedPeerLabel?: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly model: string;
  readonly upstreamMode: string;
  readonly upstreamPath: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly serviceTier?: string;
  readonly serviceTierSource: RequestServiceTierSource;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyHash?: string;
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly endToEndTps?: number;
  readonly error?: string;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
  readonly factoryDiagnostics?: Factory4xxDiagnostics;
  readonly costUsd?: number;
  readonly energyJoules?: number;
  readonly waterEvaporatedMl?: number;
}

export type RequestLogEvent =
  | { readonly type: "record"; readonly entry: RequestLogEntry }
  | { readonly type: "update"; readonly entry: RequestLogEntry };

export interface RequestLogFilters {
  readonly providerId?: string;
  readonly accountId?: string;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface RequestLogRecordInput {
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly routeKind?: RequestRouteKind;
  readonly federationOwnerSubject?: string;
  readonly routedPeerId?: string;
  readonly routedPeerLabel?: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly model: string;
  readonly upstreamMode: string;
  readonly upstreamPath: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly serviceTier?: string;
  readonly serviceTierSource?: RequestServiceTierSource;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyHash?: string;
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly endToEndTps?: number;
  readonly error?: string;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
  readonly factoryDiagnostics?: Factory4xxDiagnostics;
  readonly costUsd?: number;
  readonly energyJoules?: number;
  readonly waterEvaporatedMl?: number;
  readonly timestamp?: number;
}

export interface RequestLogHourlyBucket {
  readonly startMs: number;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyBucket {
  readonly startMs: number;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyModelBucket {
  readonly startMs: number;
  readonly providerId: string;
  readonly model: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly endToEndTpsSum: number;
  readonly endToEndTpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyAccountBucket {
  readonly startMs: number;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly endToEndTpsSum: number;
  readonly endToEndTpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogCoverage {
  readonly earliestEntryAtMs: number | null;
  readonly earliestHourlyBucketAtMs: number | null;
  readonly earliestDailyBucketAtMs: number | null;
  readonly earliestModelBreakdownAtMs: number | null;
  readonly earliestAccountBreakdownAtMs: number | null;
  readonly retainedEntryCount: number;
  readonly maxEntries: number;
}

export interface AccountUsageAccumulator {
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly endToEndTpsSum: number;
  readonly endToEndTpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogPerfSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly model: string;
  readonly upstreamMode: string;
  readonly sampleCount: number;
  readonly ewmaTtftMs: number;
  readonly ewmaTps: number | null;
  readonly ewmaEndToEndTps: number | null;
  readonly updatedAt: number;
}

export interface RequestLogMirror {
  upsertEntry(entry: RequestLogEntry): Promise<void>;
  close?(): Promise<void>;
}

export interface RequestLogUpdatePatch {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyHash?: string;
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly endToEndTps?: number;
  readonly error?: string;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
  readonly factoryDiagnostics?: Factory4xxDiagnostics;
  readonly costUsd?: number;
  readonly energyJoules?: number;
  readonly waterEvaporatedMl?: number;
}

// The store (journal, metadata, quarantine, compaction, mirror, subscribers)
// is proxx.runtime.request-log/create-request-log-store-js; this class only
// keeps the exported signature.
interface RequestLogStoreKernel {
  warmup(): Promise<void>;
  subscribe(listener: (event: RequestLogEvent) => void): () => void;
  record(input: RequestLogRecordInput): RequestLogEntry;
  update(entryId: string, patch: RequestLogUpdatePatch): RequestLogEntry | undefined;
  refreshDerivedEstimates(): number;
  close(): Promise<void>;
  snapshot(): RequestLogEntry[];
  snapshotSinceWithLimit(
    sinceMs: number,
    limit: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): RequestLogEntry[];
  hourlyBuckets(sinceMs?: number): RequestLogHourlyBucket[];
  dailyBuckets(sinceMs?: number): RequestLogDailyBucket[];
  dailyModelBuckets(sinceMs?: number): RequestLogDailyModelBucket[];
  dailyAccountBuckets(sinceMs?: number): RequestLogDailyAccountBucket[];
  accountAccumulators(): AccountUsageAccumulator[];
  coverage(): RequestLogCoverage;
  perfSummary(providerId: string, accountId: string, model: string, upstreamMode: string): RequestLogPerfSummary | undefined;
  modelPerfSummary(providerId: string, model: string, upstreamMode: string): RequestLogPerfSummary | undefined;
  list(filters: RequestLogFilters): RequestLogEntry[];
  countRequestsSince(sinceMs: number, filters: RequestLogFilters): number;
  providerSummary(): Record<string, { readonly count: number; readonly lastTimestamp: number }>;
}

export class RequestLogStore {
  private readonly kernel: RequestLogStoreKernel;

  public constructor(
    filePath: string,
    maxEntries: number = 1000,
    persistIntervalMs: number = 1000,
    mirror?: RequestLogMirror,
  ) {
    this.kernel = kernels.createRequestLogStore({
      filePath,
      maxEntries,
      persistIntervalMs,
      mirror,
      estimate: estimateRequestCost,
    }) as RequestLogStoreKernel;
  }

  public async warmup(): Promise<void> {
    await this.kernel.warmup();
  }

  public subscribe(listener: (event: RequestLogEvent) => void): () => void {
    return this.kernel.subscribe(listener);
  }

  public record(input: RequestLogRecordInput): RequestLogEntry {
    return this.kernel.record(input);
  }

  public update(entryId: string, patch: RequestLogUpdatePatch): RequestLogEntry | undefined {
    return this.kernel.update(entryId, patch);
  }

  public refreshDerivedEstimates(): number {
    return this.kernel.refreshDerivedEstimates();
  }

  public snapshot(): RequestLogEntry[] {
    return this.kernel.snapshot();
  }

  public snapshotSinceWithLimit(
    sinceMs: number,
    limit: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): RequestLogEntry[] {
    return this.kernel.snapshotSinceWithLimit(sinceMs, limit, after);
  }

  public snapshotHourlyBuckets(sinceMs?: number): RequestLogHourlyBucket[] {
    return this.kernel.hourlyBuckets(sinceMs);
  }

  public snapshotDailyBuckets(sinceMs?: number): RequestLogDailyBucket[] {
    return this.kernel.dailyBuckets(sinceMs);
  }

  public snapshotDailyModelBuckets(sinceMs?: number): RequestLogDailyModelBucket[] {
    return this.kernel.dailyModelBuckets(sinceMs);
  }

  public snapshotDailyAccountBuckets(sinceMs?: number): RequestLogDailyAccountBucket[] {
    return this.kernel.dailyAccountBuckets(sinceMs);
  }

  public snapshotAccountAccumulators(): readonly AccountUsageAccumulator[] {
    return this.kernel.accountAccumulators();
  }

  public getCoverage(): RequestLogCoverage {
    return this.kernel.coverage();
  }

  public getPerfSummary(
    providerId: string,
    accountId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    return this.kernel.perfSummary(providerId, accountId, model, upstreamMode);
  }

  public getModelPerfSummary(
    providerId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    return this.kernel.modelPerfSummary(providerId, model, upstreamMode);
  }

  public async close(): Promise<void> {
    await this.kernel.close();
  }

  public list(filters: RequestLogFilters = {}): RequestLogEntry[] {
    return this.kernel.list(filters);
  }

  public countRequestsSince(sinceMs: number, filters: RequestLogFilters = {}): number {
    return this.kernel.countRequestsSince(sinceMs, filters);
  }

  public providerSummary(): Record<string, { readonly count: number; readonly lastTimestamp: number }> {
    return this.kernel.providerSummary();
  }
}
