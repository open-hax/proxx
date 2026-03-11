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
  readonly error?: string;
  readonly timestamp?: number;
}

interface RequestLogDb {
  readonly entries: RequestLogEntry[];
}

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
    error: asString(raw.error),
  };
}

function hydrateDb(raw: unknown, maxEntries: number): RequestLogDb {
  if (Array.isArray(raw)) {
    return {
      entries: raw
        .map((entry) => hydrateEntry(entry))
        .filter((entry): entry is RequestLogEntry => entry !== null)
        .slice(-maxEntries),
    };
  }

  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    return emptyDb();
  }

  return {
    entries: raw.entries
      .map((entry) => hydrateEntry(entry))
      .filter((entry): entry is RequestLogEntry => entry !== null)
      .slice(-maxEntries),
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

export class RequestLogStore {
  private readonly entries: RequestLogEntry[] = [];
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
      error: input.error,
    };

    this.entries.push(entry);
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }

    this.schedulePersist();

    return entry;
  }

  public update(
    entryId: string,
    patch: {
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
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
      error: patch.error ?? current.error,
    };

    this.entries.splice(entryIndex, 1, next);
    this.schedulePersist();
    return next;
  }

  public snapshot(): RequestLogEntry[] {
    return [...this.entries];
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

  private async loadFromDisk(): Promise<void> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(contents);
      const db = hydrateDb(parsed, this.maxEntries);
      this.entries.splice(0, this.entries.length, ...db.entries);
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
    await writeFile(this.filePath, JSON.stringify({ entries: this.entries }, null, 2), "utf8");
  }
}
