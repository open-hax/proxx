import { kernels } from "./cljs-kernels.js";

export interface ProviderRoutePheromoneRecord {
  readonly providerId: string;
  readonly model: string;
  readonly pheromone: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly updatedAt: number;
}

interface ProviderRoutePheromoneStoreKernel {
  warmup(): Promise<void>;
  getPheromone(providerId: string, model: string): number;
  noteSuccess(providerId: string, model: string, quality: number): Promise<void>;
  noteFailure(providerId: string, model: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Pheromone records persisted as one JSON file. The records and their updates
 * are proxx.routing.pheromone; the cache, the mutation queue and the
 * write-behind are proxx.runtime.pheromone-store. This class keeps the names
 * and types callers already use.
 */
export class ProviderRoutePheromoneStore {
  private readonly impl: ProviderRoutePheromoneStoreKernel;

  public constructor(filePath: string, persistIntervalMs: number = 250) {
    this.impl = kernels.createProviderRoutePheromoneStore(filePath, persistIntervalMs) as ProviderRoutePheromoneStoreKernel;
  }

  public warmup(): Promise<void> {
    return this.impl.warmup();
  }

  public getPheromone(providerId: string, model: string): number {
    return this.impl.getPheromone(providerId, model);
  }

  public noteSuccess(providerId: string, model: string, quality: number): Promise<void> {
    return this.impl.noteSuccess(providerId, model, quality);
  }

  public noteFailure(providerId: string, model: string): Promise<void> {
    return this.impl.noteFailure(providerId, model);
  }

  public close(): Promise<void> {
    return this.impl.close();
  }
}
