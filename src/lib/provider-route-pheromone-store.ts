import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { kernels } from "./cljs-kernels.js";

export interface ProviderRoutePheromoneRecord {
  readonly providerId: string;
  readonly model: string;
  readonly pheromone: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly updatedAt: number;
}

interface ProviderRoutePheromoneDb {
  records: ProviderRoutePheromoneRecord[];
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
    return kernels.pheromoneGet(this.dbCache?.records ?? [], providerId, model);
  }

  public async noteSuccess(providerId: string, model: string, quality: number): Promise<void> {
    if (!kernels.pheromoneKeyValid(providerId, model)) {
      return;
    }

    await this.mutate((db) => {
      db.records = kernels.pheromoneNoteSuccess(db.records, providerId, model, quality) as ProviderRoutePheromoneRecord[];
    });
  }

  public async noteFailure(providerId: string, model: string): Promise<void> {
    if (!kernels.pheromoneKeyValid(providerId, model)) {
      return;
    }

    await this.mutate((db) => {
      db.records = kernels.pheromoneNoteFailure(db.records, providerId, model) as ProviderRoutePheromoneRecord[];
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
      this.dbCache = { records: kernels.pheromoneHydrateDb(JSON.parse(raw) as unknown) as ProviderRoutePheromoneRecord[] };
    } catch {
      this.dbCache = { records: [] };
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
