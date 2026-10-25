import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RequestLogDb {
  readonly entries: RequestLogEntry[];
  readonly hourlyBuckets?: readonly RequestLogHourlyBucket[];
  readonly dailyBuckets?: readonly RequestLogDailyBucket[];
  readonly dailyModelBuckets?: readonly RequestLogDailyModelBucket[];
  readonly dailyAccountBuckets?: readonly RequestLogDailyAccountBucket[];
  readonly accountAccumulators?: readonly AccountUsageAccumulator[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildTempFilePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function buildCorruptFilePath(filePath: string): string {
  return join(dirname(filePath), `${basename(filePath)}.corrupt-${Date.now()}-${process.pid}-${crypto.randomUUID()}`);
}

function buildMigratedFilePath(filePath: string): string {
  return join(dirname(filePath), `${basename(filePath)}.migrated-${Date.now()}-${process.pid}-${crypto.randomUUID()}`);
}

function buildLegacyFilePath(filePath: string): string | null {
  return filePath.endsWith(".jsonl") ? filePath.slice(0, -1) : null;
}

function buildMetadataFilePath(filePath: string): string {
  if (filePath.endsWith(".jsonl")) {
    return `${filePath.slice(0, -".jsonl".length)}.meta.json`;
  }

  if (filePath.endsWith(".json")) {
    return `${filePath.slice(0, -".json".length)}.meta.json`;
  }

  return `${filePath}.meta.json`;
}

function serializeEntry(entry: RequestLogEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

interface RequestLogCore {
  record(input: RequestLogRecordInput): { readonly entry: RequestLogEntry; readonly overflowed: boolean };
  update(entryId: string, patch: object): RequestLogEntry | undefined;
  refreshDerivedEstimates(estimate: typeof estimateRequestCost, onUpdated: (entry: RequestLogEntry) => void): number;
  load(raw: unknown, estimate: typeof estimateRequestCost): unknown;
  hydrateEntry(raw: unknown): unknown;
  hydrateMetadata(parsed: unknown): unknown;
  reset(): void;
  entryCount(): number;
  snapshot(): RequestLogEntry[];
  snapshotSinceWithLimit(sinceMs: number, limit: number, after?: { readonly timestampMs: number; readonly id: string }): RequestLogEntry[];
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
  shouldCompactJournal(force: boolean, needsCompaction: boolean, journalLines: number, pending: number): boolean;
}


export class RequestLogStore {
  private readonly subscribers = new Set<(event: RequestLogEvent) => void>();
  // The ledger, its indexes and every report are in proxx.analytics.request-log;
  // this class owns persistence, the SQL mirror and subscriber fan-out.
  private readonly core: RequestLogCore;
  private pendingJournalEntries: RequestLogEntry[] = [];
  private warmupPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPending = false;
  private mirrorChain: Promise<void> = Promise.resolve();
  private mirrorFailureCount = 0;
  private lastMirrorWarningAt = 0;
  private journalLineCount = 0;
  private needsCompaction = false;
  private closed = false;

  public constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = 1000,
    private readonly persistIntervalMs: number = 1000,
    private readonly mirror?: RequestLogMirror,
  ) {
    this.core = kernels.createRequestLogCore(maxEntries) as RequestLogCore;
  }

  public async warmup(): Promise<void> {
    if (this.warmupPromise) {
      await this.warmupPromise;
      return;
    }

    this.warmupPromise = this.loadFromDisk();
    await this.warmupPromise;
  }

  public subscribe(listener: (event: RequestLogEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(event: RequestLogEvent): void {
    if (this.subscribers.size === 0) {
      return;
    }

    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // Ignore subscriber failures so observability can never take down logging.
      }
    }
  }

  public record(input: RequestLogRecordInput): RequestLogEntry {
    if (this.closed) {
      throw new Error("request log store is closed");
    }

    const { entry, overflowed } = this.core.record(input);
    if (overflowed) {
      this.needsCompaction = true;
    }

    this.pendingJournalEntries.push(entry);
    this.schedulePersist();
    this.queueMirror(entry);

    this.emit({ type: "record", entry });

    return entry;
  }

  public update(
    entryId: string,
    patch: {
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
    },
  ): RequestLogEntry | undefined {
    if (this.closed) {
      return undefined;
    }

    const next = this.core.update(entryId, patch);
    if (next === undefined) {
      return undefined;
    }

    this.pendingJournalEntries.push(next);
    this.schedulePersist();
    this.queueMirror(next);

    this.emit({ type: "update", entry: next });
    return next;
  }

  public refreshDerivedEstimates(): number {
    if (this.closed) {
      return 0;
    }

    const updatedCount = this.core.refreshDerivedEstimates(estimateRequestCost, (next) => {
      this.pendingJournalEntries.push(next);
      this.queueMirror(next);
      this.emit({ type: "update", entry: next });
    });

    if (updatedCount > 0) {
      this.schedulePersist();
    }

    return updatedCount;
  }

  public snapshot(): RequestLogEntry[] {
    return this.core.snapshot();
  }

  public snapshotSinceWithLimit(
    sinceMs: number,
    limit: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): RequestLogEntry[] {
    return this.core.snapshotSinceWithLimit(sinceMs, limit, after);
  }

  public snapshotHourlyBuckets(sinceMs?: number): RequestLogHourlyBucket[] {
    return this.core.hourlyBuckets(sinceMs);
  }

  public snapshotDailyBuckets(sinceMs?: number): RequestLogDailyBucket[] {
    return this.core.dailyBuckets(sinceMs);
  }

  public snapshotDailyModelBuckets(sinceMs?: number): RequestLogDailyModelBucket[] {
    return this.core.dailyModelBuckets(sinceMs);
  }

  public snapshotDailyAccountBuckets(sinceMs?: number): RequestLogDailyAccountBucket[] {
    return this.core.dailyAccountBuckets(sinceMs);
  }

  public snapshotAccountAccumulators(): readonly AccountUsageAccumulator[] {
    return this.core.accountAccumulators();
  }

  public getCoverage(): RequestLogCoverage {
    return this.core.coverage();
  }

  public getPerfSummary(
    providerId: string,
    accountId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    return this.core.perfSummary(providerId, accountId, model, upstreamMode);
  }

  public getModelPerfSummary(
    providerId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    return this.core.modelPerfSummary(providerId, model, upstreamMode);
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.queuePersist(true);
    await this.persistChain.catch(() => undefined);
    try {
      await this.mirrorChain;
    } catch (error) {
      this.noteMirrorFailure("flush", error);
    }
    if (this.mirror?.close) {
      try {
        await this.mirror.close();
      } catch (error) {
        this.noteMirrorFailure("close", error);
      }
    }
  }

  private queueMirror(entry: RequestLogEntry): void {
    if (!this.mirror) {
      return;
    }

    this.mirrorChain = this.mirrorChain
      .then(async () => {
        await this.mirror?.upsertEntry(entry);
      })
      .catch((error) => {
        this.noteMirrorFailure("upsert", error);
      });
  }

  private noteMirrorFailure(stage: "upsert" | "flush" | "close", error: unknown): void {
    this.mirrorFailureCount += 1;
    const now = Date.now();
    const count = this.mirrorFailureCount;
    const shouldWarn = count <= 3 || count === 5 || count === 10 || now - this.lastMirrorWarningAt >= 60_000;
    if (!shouldWarn) {
      return;
    }

    this.lastMirrorWarningAt = now;
    console.warn(`[request-log-store] mirror ${stage} failed (#${count}): ${formatErrorMessage(error)}`);
  }

  public list(filters: RequestLogFilters = {}): RequestLogEntry[] {
    return this.core.list(filters);
  }

  public countRequestsSince(sinceMs: number, filters: RequestLogFilters = {}): number {
    return this.core.countRequestsSince(sinceMs, filters);
  }

  public providerSummary(): Record<string, { readonly count: number; readonly lastTimestamp: number }> {
    return this.core.providerSummary();
  }

  private resetState(): void {
    this.core.reset();
    this.pendingJournalEntries = [];
    this.journalLineCount = 0;
    this.needsCompaction = false;
  }

  private async applyLoadedDb(raw: unknown): Promise<void> {
    this.resetState();
    const repaired = this.core.load(raw, estimateRequestCost) as RequestLogEntry[];

    // Sync repaired entries to the SQL mirror so dashboard analytics
    // reflect the corrected costs.
    if (this.mirror) {
      for (const repairedEntry of repaired) {
        try {
          await this.mirror.upsertEntry(repairedEntry);
        } catch (error) {
          console.warn(`[request-log-store] Failed to mirror repaired entry ${repairedEntry.id}: ${formatErrorMessage(error)}`);
        }
      }
    }
  }

  private async quarantineCorruptFile(sourcePath: string, error: SyntaxError): Promise<void> {
    const corruptFilePath = buildCorruptFilePath(sourcePath);

    try {
      await rename(sourcePath, corruptFilePath);
      console.warn(
        `[request-log-store] Failed to parse request logs from ${sourcePath}; moved corrupt file to ${corruptFilePath}: ${error.message}`,
      );
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw renameError;
      }

      console.warn(
        `[request-log-store] Failed to parse request logs from ${sourcePath}; file disappeared before quarantine: ${error.message}`,
      );
    }

    this.resetState();
    await this.persistNow(true);
  }

  private async quarantineCorruptLines(sourcePath: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    const corruptFilePath = buildCorruptFilePath(sourcePath);
    await writeFile(corruptFilePath, `${lines.join("\n")}\n`, "utf8");
    console.warn(
      `[request-log-store] Ignored ${lines.length} malformed JSONL request log lines from ${sourcePath}; wrote them to ${corruptFilePath}`,
    );
  }

  private async quarantineCorruptMetadataFile(error: SyntaxError): Promise<void> {
    const metadataFilePath = buildMetadataFilePath(this.filePath);
    const corruptFilePath = buildCorruptFilePath(metadataFilePath);

    try {
      await rename(metadataFilePath, corruptFilePath);
      console.warn(
        `[request-log-store] Failed to parse request log metadata from ${metadataFilePath}; moved corrupt file to ${corruptFilePath}: ${error.message}`,
      );
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw renameError;
      }

      console.warn(
        `[request-log-store] Failed to parse request log metadata from ${metadataFilePath}; file disappeared before quarantine: ${error.message}`,
      );
    }
  }

  private async archiveMigratedLegacyFile(sourcePath: string): Promise<void> {
    if (sourcePath === this.filePath) {
      return;
    }

    const migratedFilePath = buildMigratedFilePath(sourcePath);
    try {
      await rename(sourcePath, migratedFilePath);
      console.info(
        `[request-log-store] Migrated legacy request logs from ${sourcePath} to ${this.filePath}; archived original file at ${migratedFilePath}`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private async resolveSourcePath(): Promise<string | null> {
    try {
      await access(this.filePath);
      return this.filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }

    const legacyFilePath = buildLegacyFilePath(this.filePath);
    if (!legacyFilePath) {
      return null;
    }

    try {
      await access(legacyFilePath);
      return legacyFilePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }

    return null;
  }

  private async loadMetadataFromDisk(): Promise<Omit<RequestLogDb, "entries">> {
    const metadataFilePath = buildMetadataFilePath(this.filePath);
    let contents: string;

    try {
      contents = await readFile(metadataFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return {
          hourlyBuckets: [],
          dailyBuckets: [],
          dailyModelBuckets: [],
          dailyAccountBuckets: [],
          accountAccumulators: [],
        };
      }

      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      await this.quarantineCorruptMetadataFile(error);
      return {
        hourlyBuckets: [],
        dailyBuckets: [],
        dailyModelBuckets: [],
        dailyAccountBuckets: [],
        accountAccumulators: [],
      };
    }

    return this.core.hydrateMetadata(parsed) as Omit<RequestLogDb, "entries">;
  }

  private snapshotMetadata(): Omit<RequestLogDb, "entries"> {
    return {
      hourlyBuckets: this.snapshotHourlyBuckets(),
      dailyBuckets: this.snapshotDailyBuckets(),
      dailyModelBuckets: this.snapshotDailyModelBuckets(),
      dailyAccountBuckets: this.snapshotDailyAccountBuckets(),
      accountAccumulators: this.snapshotAccountAccumulators(),
    };
  }

  private async persistMetadataNow(): Promise<void> {
    const metadataFilePath = buildMetadataFilePath(this.filePath);
    const tempFilePath = buildTempFilePath(metadataFilePath);

    try {
      await writeFile(tempFilePath, JSON.stringify(this.snapshotMetadata(), null, 2), "utf8");
      await rename(tempFilePath, metadataFilePath);
    } catch (error) {
      await rm(tempFilePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async loadEntriesFromJsonl(sourcePath: string): Promise<{
    readonly entries: readonly RequestLogEntry[];
    readonly malformedLines: readonly string[];
    readonly lineCount: number;
  }> {
    const entriesById = new Map<string, RequestLogEntry>();
    const malformedLines: string[] = [];
    let lineCount = 0;

    const input = createReadStream(sourcePath, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const rawLine of reader) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }

        lineCount += 1;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          malformedLines.push(rawLine);
          continue;
        }

        const entry = this.core.hydrateEntry(parsed) as RequestLogEntry | null;
        if (!entry) {
          malformedLines.push(rawLine);
          continue;
        }

        const hadEntry = entriesById.has(entry.id);
        entriesById.set(entry.id, entry);
        if (!hadEntry && entriesById.size > this.maxEntries) {
          const oldestEntryId = entriesById.keys().next().value;
          if (typeof oldestEntryId === "string") {
            entriesById.delete(oldestEntryId);
          }
        }
      }
    } finally {
      reader.close();
      input.close();
    }

    return {
      entries: [...entriesById.values()],
      malformedLines,
      lineCount,
    };
  }

  private async loadLegacyDb(sourcePath: string): Promise<boolean> {
    const contents = await readFile(sourcePath, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      await this.quarantineCorruptFile(sourcePath, error);
      return false;
    }

    const isLegacyPayload = Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.entries));
    if (!isLegacyPayload) {
      await this.quarantineCorruptFile(sourcePath, new SyntaxError("Request log payload is not a valid legacy JSON request log database"));
      return false;
    }

    await this.applyLoadedDb(parsed);
    this.journalLineCount = this.core.entryCount();
    return true;
  }

  private shouldCompactJournal(forceCompact: boolean): boolean {
    return this.core.shouldCompactJournal(
      forceCompact,
      this.needsCompaction,
      this.journalLineCount,
      this.pendingJournalEntries.length,
    );
  }

  private async loadFromDisk(): Promise<void> {
    const sourcePath = await this.resolveSourcePath();
    if (!sourcePath) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, "", "utf8");
      await this.persistMetadataNow();
      return;
    }

    const jsonlLoad = await this.loadEntriesFromJsonl(sourcePath);
    const looksLikeLegacyJson = jsonlLoad.entries.length === 0 && jsonlLoad.malformedLines.length > 0;

    if (looksLikeLegacyJson) {
      const loadedLegacyDb = await this.loadLegacyDb(sourcePath);
      if (!loadedLegacyDb) {
        return;
      }

      await this.persistNow(true);
      await this.archiveMigratedLegacyFile(sourcePath);
      return;
    }

    const metadata = await this.loadMetadataFromDisk();
    await this.applyLoadedDb({
      entries: jsonlLoad.entries,
      hourlyBuckets: metadata.hourlyBuckets,
      dailyBuckets: metadata.dailyBuckets,
      dailyModelBuckets: metadata.dailyModelBuckets,
      dailyAccountBuckets: metadata.dailyAccountBuckets,
      accountAccumulators: metadata.accountAccumulators,
    });
    this.journalLineCount = jsonlLoad.lineCount;

    if (jsonlLoad.malformedLines.length > 0) {
      await this.quarantineCorruptLines(sourcePath, jsonlLoad.malformedLines);
      await this.persistNow(true);
      return;
    }

    if (sourcePath !== this.filePath) {
      await this.persistNow(true);
    }
  }

  private schedulePersist(): void {
    if (this.closed) {
      return;
    }

    this.persistPending = true;
    if (this.persistTimer) {
      return;
    }

    if (this.persistIntervalMs === 0) {
      void this.queuePersist();
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.queuePersist();
    }, this.persistIntervalMs);
    this.persistTimer.unref?.();
  }

  private async queuePersist(force = false): Promise<void> {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        if (!force && !this.persistPending) {
          return;
        }

        this.persistPending = false;
        await this.persistNow(force);
      });
    await this.persistChain;
  }

  private async persistNow(forceCompact = false): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    if (this.shouldCompactJournal(forceCompact)) {
      const tempFilePath = buildTempFilePath(this.filePath);
      const snapshot = this.snapshot();
      const pendingBeforeRewrite = this.pendingJournalEntries;
      this.pendingJournalEntries = [];

      try {
        await writeFile(tempFilePath, snapshot.map((entry) => serializeEntry(entry)).join(""), "utf8");
        await rename(tempFilePath, this.filePath);
        this.journalLineCount = snapshot.length;
        this.needsCompaction = false;
        await this.persistMetadataNow();
        return;
      } catch (error) {
        this.pendingJournalEntries = [...pendingBeforeRewrite, ...this.pendingJournalEntries];
        await rm(tempFilePath, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    if (this.pendingJournalEntries.length === 0) {
      await this.persistMetadataNow();
      return;
    }

    const pendingEntries = this.pendingJournalEntries;
    this.pendingJournalEntries = [];

    try {
      await appendFile(this.filePath, pendingEntries.map((entry) => serializeEntry(entry)).join(""), "utf8");
      this.journalLineCount += pendingEntries.length;
      await this.persistMetadataNow();
    } catch (error) {
      this.pendingJournalEntries = [...pendingEntries, ...this.pendingJournalEntries];
      throw error;
    }
  }
}
