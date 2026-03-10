import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PromptAffinityRecord {
  readonly promptCacheKey: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly updatedAt: number;
}

interface PromptAffinityDb {
  readonly records: PromptAffinityRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyDb(): PromptAffinityDb {
  return { records: [] };
}

function hydrateRecord(raw: unknown): PromptAffinityRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const promptCacheKey = typeof raw.promptCacheKey === "string"
    ? raw.promptCacheKey.trim()
    : typeof raw.prompt_cache_key === "string"
      ? raw.prompt_cache_key.trim()
      : "";
  const providerId = typeof raw.providerId === "string" ? raw.providerId.trim() : "";
  const accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();

  if (!promptCacheKey || !providerId || !accountId) {
    return null;
  }

  return {
    promptCacheKey,
    providerId,
    accountId,
    updatedAt,
  };
}

function hydrateDb(raw: unknown): PromptAffinityDb {
  if (!isRecord(raw) || !Array.isArray(raw.records)) {
    return emptyDb();
  }

  return {
    records: raw.records
      .map((entry) => hydrateRecord(entry))
      .filter((entry): entry is PromptAffinityRecord => entry !== null),
  };
}

export class PromptAffinityStore {
  private dbCache: PromptAffinityDb | null = null;
  private mutationChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async warmup(): Promise<void> {
    await this.readDb();
  }

  public async get(promptCacheKey: string): Promise<PromptAffinityRecord | undefined> {
    const normalized = promptCacheKey.trim();
    if (!normalized) {
      return undefined;
    }

    const db = await this.readDb();
    return db.records.find((record) => record.promptCacheKey === normalized);
  }

  public async upsert(promptCacheKey: string, providerId: string, accountId: string): Promise<void> {
    const normalizedKey = promptCacheKey.trim();
    if (!normalizedKey) {
      return;
    }

    await this.mutate((db) => {
      const next: PromptAffinityRecord = {
        promptCacheKey: normalizedKey,
        providerId: providerId.trim(),
        accountId: accountId.trim(),
        updatedAt: Date.now(),
      };
      const index = db.records.findIndex((record) => record.promptCacheKey === normalizedKey);
      if (index >= 0) {
        db.records[index] = next;
      } else {
        db.records.push(next);
      }
    });
  }

  public async delete(promptCacheKey: string): Promise<void> {
    const normalized = promptCacheKey.trim();
    if (!normalized) {
      return;
    }

    await this.mutate((db) => {
      const index = db.records.findIndex((record) => record.promptCacheKey === normalized);
      if (index >= 0) {
        db.records.splice(index, 1);
      }
    });
  }

  private async readDb(): Promise<PromptAffinityDb> {
    if (this.dbCache) {
      return this.dbCache;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.dbCache = hydrateDb(JSON.parse(raw) as unknown);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code === "ENOENT") {
        this.dbCache = emptyDb();
      } else {
        throw error;
      }
    }

    return this.dbCache;
  }

  private async mutate(mutator: (db: PromptAffinityDb) => void): Promise<void> {
    this.mutationChain = this.mutationChain.then(async () => {
      const db = await this.readDb();
      mutator(db);
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(db, null, 2) + "\n", "utf8");
    });
    await this.mutationChain;
  }
}
