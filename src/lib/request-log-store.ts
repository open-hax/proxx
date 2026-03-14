import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RequestAuthType = "api_key" | "oauth_bearer" | "local" | "none";
export type RequestServiceTierSource = "fast_mode" | "explicit" | "none";

export interface RequestLogEntry {
  readonly id: string;
  readonly timestamp: number;
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
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly error?: string;
}

export interface RequestLogFilters {
  readonly providerId?: string;
  readonly accountId?: string;
  readonly limit?: number;
}

export interface RequestLogRecordInput {
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
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly error?: string;
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
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
}

export interface RequestLogPerfSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly model: string;
  readonly upstreamMode: string;
  readonly sampleCount: number;
  readonly ewmaTtftMs: number;
  readonly ewmaTps: number | null;
  readonly updatedAt: number;
}

interface RequestLogDb {
  readonly entries: RequestLogEntry[];
  readonly hourlyBuckets?: readonly RequestLogHourlyBucket[];
}

type HourlyBucket = {
  startMs: number;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  fastModeRequestCount: number;
  priorityRequestCount: number;
  standardRequestCount: number;
};

type PerfIndexEntry = {
  providerId: string;
  accountId: string;
  model: string;
  upstreamMode: string;
  sampleCount: number;
  ewmaTtftMs: number;
  ewmaTps: number | null;
  updatedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeOptionalCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value >= 0 ? value : undefined;
}

function emptyDb(): RequestLogDb {
  return {
    entries: [],
    hourlyBuckets: [],
  };
}

function hydrateEntry(raw: unknown): RequestLogEntry | null {
  if (!isRecord(raw)) {
    return null;
  }

  const providerId = asString(raw.providerId)?.trim();
  const accountId = asString(raw.accountId)?.trim();
  const authType = raw.authType;
  const model = asString(raw.model)?.trim();
  const upstreamMode = asString(raw.upstreamMode)?.trim();
  const upstreamPath = asString(raw.upstreamPath)?.trim();
  const status = asNumber(raw.status);
  const latencyMs = asNumber(raw.latencyMs);
  const serviceTier = asString(raw.serviceTier)?.trim();
  const serviceTierSource = raw.serviceTierSource;

  if (!providerId || !accountId || !model || !upstreamMode || !upstreamPath || status === undefined || latencyMs === undefined) {
    return null;
  }

  const normalizedAuthType: RequestAuthType =
    authType === "api_key" || authType === "oauth_bearer" || authType === "local" || authType === "none"
      ? authType
      : "none";

  const normalizedServiceTierSource: RequestServiceTierSource =
    serviceTierSource === "fast_mode" || serviceTierSource === "explicit" || serviceTierSource === "none"
      ? serviceTierSource
      : serviceTier
        ? "explicit"
        : "none";

  return {
    id: asString(raw.id) ?? crypto.randomUUID(),
    timestamp: asNumber(raw.timestamp) ?? Date.now(),
    providerId,
    accountId,
    authType: normalizedAuthType,
    model,
    upstreamMode,
    upstreamPath,
    status,
    latencyMs,
    serviceTier,
    serviceTierSource: normalizedServiceTierSource,
    promptTokens: sanitizeOptionalCount(asNumber(raw.promptTokens)),
    completionTokens: sanitizeOptionalCount(asNumber(raw.completionTokens)),
    totalTokens: sanitizeOptionalCount(asNumber(raw.totalTokens)),
    cachedPromptTokens: sanitizeOptionalCount(asNumber(raw.cachedPromptTokens)),
    promptCacheKeyUsed: raw.promptCacheKeyUsed === true,
    cacheHit: raw.cacheHit === true,
    ttftMs: sanitizeOptionalCount(asNumber(raw.ttftMs)),
    tps: asNumber(raw.tps),
    error: asString(raw.error),
  };
}

function hydrateHourlyBucket(raw: unknown): RequestLogHourlyBucket | null {
  if (!isRecord(raw)) {
    return null;
  }

  const startMs = asNumber(raw.startMs);
  if (startMs === undefined) {
    return null;
  }

  return {
    startMs,
    requestCount: asNumber(raw.requestCount) ?? 0,
    errorCount: asNumber(raw.errorCount) ?? 0,
    totalTokens: asNumber(raw.totalTokens) ?? 0,
    promptTokens: asNumber(raw.promptTokens) ?? 0,
    completionTokens: asNumber(raw.completionTokens) ?? 0,
    cachedPromptTokens: asNumber(raw.cachedPromptTokens) ?? 0,
    cacheHitCount: asNumber(raw.cacheHitCount) ?? 0,
    cacheKeyUseCount: asNumber(raw.cacheKeyUseCount) ?? 0,
    fastModeRequestCount: asNumber(raw.fastModeRequestCount) ?? 0,
    priorityRequestCount: asNumber(raw.priorityRequestCount) ?? 0,
    standardRequestCount: asNumber(raw.standardRequestCount) ?? 0,
  };
}

function hydrateDb(raw: unknown, maxEntries: number): RequestLogDb {
  if (Array.isArray(raw)) {
    return {
      entries: raw
        .map((entry) => hydrateEntry(entry))
        .filter((entry): entry is RequestLogEntry => entry !== null)
        .slice(-maxEntries),
      hourlyBuckets: [],
    };
  }

  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    return emptyDb();
  }

  const hourlyBuckets = Array.isArray(raw.hourlyBuckets)
    ? raw.hourlyBuckets
        .map((bucket) => hydrateHourlyBucket(bucket))
        .filter((bucket): bucket is RequestLogHourlyBucket => bucket !== null)
    : [];

  return {
    entries: raw.entries
      .map((entry) => hydrateEntry(entry))
      .filter((entry): entry is RequestLogEntry => entry !== null)
      .slice(-maxEntries),
    hourlyBuckets,
  };
}

function sanitizeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }

  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return fallback;
  }

  return normalized;
}

function hourBucketStartMs(timestampMs: number): number {
  return Math.floor(timestampMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

function sumCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export class RequestLogStore {
  private readonly entries: RequestLogEntry[] = [];
  private readonly hourlyBuckets = new Map<number, HourlyBucket>();
  private readonly perfIndex = new Map<string, PerfIndexEntry>();
  private warmupPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = 1000,
  ) {}

  public async warmup(): Promise<void> {
    if (this.warmupPromise) {
      await this.warmupPromise;
      return;
    }

    this.warmupPromise = this.loadFromDisk();
    await this.warmupPromise;
  }

  public record(input: RequestLogRecordInput): RequestLogEntry {
    if (this.closed) {
      throw new Error("request log store is closed");
    }

    const entry: RequestLogEntry = {
      id: crypto.randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      providerId: input.providerId,
      accountId: input.accountId,
      authType: input.authType,
      model: input.model,
      upstreamMode: input.upstreamMode,
      upstreamPath: input.upstreamPath,
      status: input.status,
      latencyMs: input.latencyMs,
      serviceTier: input.serviceTier?.trim() || undefined,
      serviceTierSource: input.serviceTierSource ?? (input.serviceTier ? "explicit" : "none"),
      promptTokens: sanitizeOptionalCount(input.promptTokens),
      completionTokens: sanitizeOptionalCount(input.completionTokens),
      totalTokens: sanitizeOptionalCount(input.totalTokens),
      cachedPromptTokens: sanitizeOptionalCount(input.cachedPromptTokens),
      promptCacheKeyUsed: input.promptCacheKeyUsed === true,
      cacheHit: input.cacheHit === true,
      ttftMs: sanitizeOptionalCount(input.ttftMs),
      tps: input.tps,
      error: input.error,
    };

    this.entries.push(entry);
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }

    this.applyEntryToHourlyBuckets(entry);
    this.updatePerfIndexFromEntry(entry);
    this.schedulePersist();

    return entry;
  }

  public update(
    entryId: string,
    patch: {
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
      readonly cachedPromptTokens?: number;
      readonly promptCacheKeyUsed?: boolean;
      readonly cacheHit?: boolean;
      readonly ttftMs?: number;
      readonly tps?: number;
      readonly error?: string;
    },
  ): RequestLogEntry | undefined {
    if (this.closed) {
      return undefined;
    }

    const entryIndex = this.entries.findIndex((entry) => entry.id === entryId);
    if (entryIndex < 0) {
      return undefined;
    }

    const current = this.entries[entryIndex];
    if (!current) {
      return undefined;
    }

    const next: RequestLogEntry = {
      ...current,
      promptTokens: sanitizeOptionalCount(patch.promptTokens) ?? current.promptTokens,
      completionTokens: sanitizeOptionalCount(patch.completionTokens) ?? current.completionTokens,
      totalTokens: sanitizeOptionalCount(patch.totalTokens) ?? current.totalTokens,
      cachedPromptTokens: sanitizeOptionalCount(patch.cachedPromptTokens) ?? current.cachedPromptTokens,
      promptCacheKeyUsed: patch.promptCacheKeyUsed ?? current.promptCacheKeyUsed,
      cacheHit: patch.cacheHit ?? current.cacheHit,
      ttftMs: sanitizeOptionalCount(patch.ttftMs) ?? current.ttftMs,
      tps: typeof patch.tps === "number" && Number.isFinite(patch.tps) ? patch.tps : current.tps,
      error: patch.error ?? current.error,
    };

    this.entries.splice(entryIndex, 1, next);
    this.applyEntryDeltaToHourlyBuckets(next, current);
    this.updatePerfIndexFromEntry(next);
    this.schedulePersist();
    return next;
  }

  public snapshot(): RequestLogEntry[] {
    return [...this.entries];
  }

  public snapshotHourlyBuckets(sinceMs?: number): RequestLogHourlyBucket[] {
    const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;

    return [...this.hourlyBuckets.values()]
      .filter((bucket) => bucket.startMs >= since)
      .sort((a, b) => a.startMs - b.startMs)
      .map((bucket) => ({
        startMs: bucket.startMs,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalTokens: bucket.totalTokens,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedPromptTokens: bucket.cachedPromptTokens,
        cacheHitCount: bucket.cacheHitCount,
        cacheKeyUseCount: bucket.cacheKeyUseCount,
        fastModeRequestCount: bucket.fastModeRequestCount,
        priorityRequestCount: bucket.priorityRequestCount,
        standardRequestCount: bucket.standardRequestCount,
      }));
  }

  public getPerfSummary(
    providerId: string,
    accountId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    const key = `${providerId}\0${accountId}\0${model}\0${upstreamMode}`;
    const entry = this.perfIndex.get(key);
    return entry ? { ...entry } : undefined;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.persistChain.catch(() => undefined);
  }

  public list(filters: RequestLogFilters = {}): RequestLogEntry[] {
    const limit = sanitizeLimit(filters.limit, 200);

    const filtered = this.entries.filter((entry) => {
      if (filters.providerId && entry.providerId !== filters.providerId) {
        return false;
      }

      if (filters.accountId && entry.accountId !== filters.accountId) {
        return false;
      }

      return true;
    });

    return filtered.slice(-limit).reverse();
  }

  public providerSummary(): Record<string, { readonly count: number; readonly lastTimestamp: number }> {
    const summary: Record<string, { count: number; lastTimestamp: number }> = {};

    for (const entry of this.entries) {
      const existing = summary[entry.providerId];
      if (!existing) {
        summary[entry.providerId] = {
          count: 1,
          lastTimestamp: entry.timestamp,
        };
        continue;
      }

      existing.count += 1;
      existing.lastTimestamp = Math.max(existing.lastTimestamp, entry.timestamp);
    }

    return summary;
  }

  private getOrCreateHourlyBucket(startMs: number): HourlyBucket {
    const existing = this.hourlyBuckets.get(startMs);
    if (existing) {
      return existing;
    }

    const created: HourlyBucket = {
      startMs,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      fastModeRequestCount: 0,
      priorityRequestCount: 0,
      standardRequestCount: 0,
    };

    this.hourlyBuckets.set(startMs, created);
    return created;
  }

  private pruneHourlyBuckets(now: number = Date.now()): void {
    // Keep ~8 days of buckets (safety margin).
    const cutoff = hourBucketStartMs(now - 8 * 24 * 60 * 60 * 1000);
    for (const startMs of this.hourlyBuckets.keys()) {
      if (startMs < cutoff) {
        this.hourlyBuckets.delete(startMs);
      }
    }
  }

  private applyEntryToHourlyBuckets(entry: RequestLogEntry): void {
    const bucketStart = hourBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateHourlyBucket(bucketStart);

    bucket.requestCount += 1;

    const isError = entry.status >= 400 || typeof entry.error === "string";
    if (isError) {
      bucket.errorCount += 1;
    }

    if (entry.serviceTierSource === "fast_mode") {
      bucket.fastModeRequestCount += 1;
    } else if (entry.serviceTier === "priority") {
      bucket.priorityRequestCount += 1;
    } else {
      bucket.standardRequestCount += 1;
    }

    bucket.totalTokens += sumCount(entry.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens);

    if (entry.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneHourlyBuckets(entry.timestamp);
  }

  private applyEntryDeltaToHourlyBuckets(entry: RequestLogEntry, previous: RequestLogEntry): void {
    const bucketStart = hourBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateHourlyBucket(bucketStart);

    bucket.totalTokens += sumCount(entry.totalTokens) - sumCount(previous.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens) - sumCount(previous.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens) - sumCount(previous.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens) - sumCount(previous.cachedPromptTokens);

    // promptCacheKeyUsed / cacheHit are only ever expected to flip false->true.
    if (entry.promptCacheKeyUsed && !previous.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit && !previous.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneHourlyBuckets(entry.timestamp);
  }

  private updatePerfIndexFromEntry(entry: RequestLogEntry): void {
    const key = `${entry.providerId}\0${entry.accountId}\0${entry.model}\0${entry.upstreamMode}`;

    const ttftMsRaw = typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)
      ? entry.ttftMs
      : entry.latencyMs;
    const ttftMs = Math.max(0, ttftMsRaw);

    const derivedTps =
      typeof entry.tps === "number" && Number.isFinite(entry.tps)
        ? entry.tps
        : typeof entry.completionTokens === "number" && Number.isFinite(entry.completionTokens) && entry.latencyMs > 0
          ? entry.completionTokens / (entry.latencyMs / 1000)
          : null;

    const alpha = 0.20;
    const existing = this.perfIndex.get(key);
    if (!existing) {
      this.perfIndex.set(key, {
        providerId: entry.providerId,
        accountId: entry.accountId,
        model: entry.model,
        upstreamMode: entry.upstreamMode,
        sampleCount: 1,
        ewmaTtftMs: ttftMs,
        ewmaTps: derivedTps,
        updatedAt: entry.timestamp,
      });
      return;
    }

    existing.sampleCount += 1;
    existing.ewmaTtftMs = existing.sampleCount <= 1
      ? ttftMs
      : existing.ewmaTtftMs * (1 - alpha) + ttftMs * alpha;

    if (derivedTps !== null) {
      existing.ewmaTps = existing.ewmaTps === null ? derivedTps : existing.ewmaTps * (1 - alpha) + derivedTps * alpha;
    }

    existing.updatedAt = Math.max(existing.updatedAt, entry.timestamp);
  }

  private rebuildPerfIndex(): void {
    this.perfIndex.clear();
    for (const entry of this.entries) {
      this.updatePerfIndexFromEntry(entry);
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      const db = hydrateDb(parsed, this.maxEntries);
      this.entries.splice(0, this.entries.length, ...db.entries);

      this.hourlyBuckets.clear();
      for (const bucket of db.hourlyBuckets ?? []) {
        this.hourlyBuckets.set(bucket.startMs, {
          startMs: bucket.startMs,
          requestCount: bucket.requestCount,
          errorCount: bucket.errorCount,
          totalTokens: bucket.totalTokens,
          promptTokens: bucket.promptTokens,
          completionTokens: bucket.completionTokens,
          cachedPromptTokens: bucket.cachedPromptTokens,
          cacheHitCount: bucket.cacheHitCount,
          cacheKeyUseCount: bucket.cacheKeyUseCount,
          fastModeRequestCount: bucket.fastModeRequestCount,
          priorityRequestCount: bucket.priorityRequestCount,
          standardRequestCount: bucket.standardRequestCount,
        });
      }

      this.rebuildPerfIndex();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      await this.persistNow();
    }
  }

  private schedulePersist(): void {
    if (this.closed) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await this.persistNow();
      });
  }

  private async persistNow(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({
      entries: this.entries,
      hourlyBuckets: this.snapshotHourlyBuckets(),
    }, null, 2), "utf8");
  }
}
