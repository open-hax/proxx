import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BASELINE_PHEROMONE = 0.5;
const DEFAULT_DECAY = 0.02;
const DEFAULT_REINFORCEMENT = 0.15;
const DEFAULT_PENALTY = 0.3;

export interface ProviderRoutePheromoneRecord {
  readonly providerId: string;
  readonly model: string;
  readonly pheromone: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly updatedAt: number;
}

interface ProviderRoutePheromoneDb {
  readonly records: ProviderRoutePheromoneRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyDb(): ProviderRoutePheromoneDb {
  return { records: [] };
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function recordKey(providerId: string, model: string): string {
  return `${normalizeKeyPart(providerId)}\0${normalizeKeyPart(model)}`;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePheromone(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return BASELINE_PHEROMONE;
  }
  return clamp(value);
}

function hydrateRecord(raw: unknown): ProviderRoutePheromoneRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const providerId = typeof raw.providerId === "string" ? normalizeKeyPart(raw.providerId) : "";
  const model = typeof raw.model === "string" ? normalizeKeyPart(raw.model) : "";
  if (providerId.length === 0 || model.length === 0) {
    return null;
  }

  return {
    providerId,
    model,
    pheromone: normalizePheromone(raw.pheromone),
    successCount: typeof raw.successCount === "number" && Number.isFinite(raw.successCount)
      ? Math.max(0, Math.floor(raw.successCount))
      : 0,
    failureCount: typeof raw.failureCount === "number" && Number.isFinite(raw.failureCount)
      ? Math.max(0, Math.floor(raw.failureCount))
      : 0,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : Date.now(),
  };
}

function hydrateDb(raw: unknown): ProviderRoutePheromoneDb {
  if (!isRecord(raw) || !Array.isArray(raw.records)) {
    return emptyDb();
  }

  return {
    records: raw.records
      .map((entry) => hydrateRecord(entry))
      .filter((entry): entry is ProviderRoutePheromoneRecord => entry !== null),
  };
}

function nextPheromoneOnSuccess(current: number, quality: number): number {
  const decayed = BASELINE_PHEROMONE + ((current - BASELINE_PHEROMONE) * (1 - DEFAULT_DECAY));
  return clamp(decayed + (DEFAULT_REINFORCEMENT * clamp(quality)));
}

function nextPheromoneOnFailure(current: number): number {
  const decayed = BASELINE_PHEROMONE + ((current - BASELINE_PHEROMONE) * (1 - DEFAULT_DECAY));
  return clamp(decayed - DEFAULT_PENALTY);
}

export class ProviderRoutePheromoneStore {
  private dbCache: ProviderRoutePheromoneDb | null = null;
  private mutationChain: Promise<void> = Promise.resolve();
  private persistChain: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPending = false;
  private closed = false;

  public constructor(
    private readonly filePath: string,
    private readonly persistIntervalMs: number = 250,
  ) {}

  public async warmup(): Promise<void> {
    await this.readDb();
  }

  public getPheromone(providerId: string, model: string): number {
    const db = this.dbCache;
    if (!db) {
      return BASELINE_PHEROMONE;
    }

    const key = recordKey(providerId, model);
    const record = db.records.find((entry) => recordKey(entry.providerId, entry.model) === key);
    return record?.pheromone ?? BASELINE_PHEROMONE;
  }

  public async noteSuccess(providerId: string, model: string, quality: number): Promise<void> {
    const normalizedProviderId = normalizeKeyPart(providerId);
    const normalizedModel = normalizeKeyPart(model);
    if (normalizedProviderId.length === 0 || normalizedModel.length === 0) {
      return;
    }

    await this.mutate((db) => {
      const key = recordKey(normalizedProviderId, normalizedModel);
      const index = db.records.findIndex((entry) => recordKey(entry.providerId, entry.model) === key);
      const existing = index >= 0 ? db.records[index] : undefined;
      const next: ProviderRoutePheromoneRecord = {
        providerId: normalizedProviderId,
        model: normalizedModel,
        pheromone: nextPheromoneOnSuccess(existing?.pheromone ?? BASELINE_PHEROMONE, quality),
        successCount: (existing?.successCount ?? 0) + 1,
        failureCount: existing?.failureCount ?? 0,
        updatedAt: Date.now(),
      };

      if (index >= 0) {
        db.records[index] = next;
      } else {
        db.records.push(next);
      }
    });
  }

  public async noteFailure(providerId: string, model: string): Promise<void> {
    const normalizedProviderId = normalizeKeyPart(providerId);
    const normalizedModel = normalizeKeyPart(model);
    if (normalizedProviderId.length === 0 || normalizedModel.length === 0) {
      return;
    }

    await this.mutate((db) => {
      const key = recordKey(normalizedProviderId, normalizedModel);
      const index = db.records.findIndex((entry) => recordKey(entry.providerId, entry.model) === key);
      const existing = index >= 0 ? db.records[index] : undefined;
      const next: ProviderRoutePheromoneRecord = {
        providerId: normalizedProviderId,
        model: normalizedModel,
        pheromone: nextPheromoneOnFailure(existing?.pheromone ?? BASELINE_PHEROMONE),
        successCount: existing?.successCount ?? 0,
        failureCount: (existing?.failureCount ?? 0) + 1,
        updatedAt: Date.now(),
      };

      if (index >= 0) {
        db.records[index] = next;
      } else {
        db.records.push(next);
      }
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.mutationChain;
    try {
      if (this.persistPending) {
        await this.queuePersist(true);
      }
      await this.persistChain;
    } catch {
      // Best-effort persist on close — don't block shutdown.
    }
  }

  private async readDb(): Promise<ProviderRoutePheromoneDb> {
    if (this.dbCache) {
      return this.dbCache;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.dbCache = hydrateDb(JSON.parse(raw) as unknown);
    } catch {
      this.dbCache = emptyDb();
    }

    return this.dbCache;
  }

  private async mutate(mutator: (db: ProviderRoutePheromoneDb) => void): Promise<void> {
    this.mutationChain = this.mutationChain.then(async () => {
      const db = await this.readDb();
      mutator(db);
      this.schedulePersist();
    });
    await this.mutationChain;
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
    if (!this.persistPending && !force) {
      return;
    }

    this.persistPending = false;
    this.persistChain = this.persistChain.then(async () => {
      try {
        const db = await this.readDb();
        await mkdir(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
        await rename(tempPath, this.filePath);
      } catch {
        // Best-effort — corrupt/inaccessible filesystem should not crash the proxy.
      }
    });
    await this.persistChain;
  }
}
