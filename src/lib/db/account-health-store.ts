import type { Sql } from "./index.js";
import type { ProviderCredential } from "../key-pool.js";
import { kernels } from "../cljs-kernels.js";
import { SELECT_ALL_ACCOUNT_HEALTH } from "./schema.js";

export interface HealthScore {
  providerId: string;
  accountId: string;
  score: number;
  successCount: number;
  failureCount: number;
}

interface AccountHealthFacade {
  init(): Promise<void>;
  recordSuccess(credential: ProviderCredential, status: number): void;
  recordFailure(credential: ProviderCredential, status: number, error?: string): void;
  recordQuotaExhausted(providerId: string, accountId: string, usedPercent: number): void;
  getQuotaStatus(providerId: string, accountId: string): { exhaustedAt: number | null; usedPercent: number | null };
  isQuotaExhausted(providerId: string, accountId: string, cooldownMs?: number): boolean;
  getGrowingCooldown(providerId: string, accountId: string, baseCooldownMs: number): number;
  resetQuotaExhausted(providerId: string, accountId: string): void;
  getHealthScore(providerId: string, accountId: string, expiresAt?: number): number;
  getAllHealthScores(): HealthScore[];
  sortCredentialsByHealth(credentials: readonly ProviderCredential[]): ProviderCredential[];
  flushPendingWrites(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Per-account success/failure health. Scoring, streaks, growing cooldowns and
 * write aggregation are CLJS (`proxx.credentials.health`); the atom, flush timer
 * and database are its edge (`proxx.runtime.account-health`).
 */
export class AccountHealthStore {
  private readonly impl: AccountHealthFacade;

  public constructor(sql: Sql, flushIntervalMs: number = 5000) {
    this.impl = kernels.createAccountHealthStore(sql, flushIntervalMs, SELECT_ALL_ACCOUNT_HEALTH) as AccountHealthFacade;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public recordSuccess(credential: ProviderCredential, status: number): void {
    this.impl.recordSuccess(credential, status);
  }

  public recordFailure(credential: ProviderCredential, status: number, error?: string): void {
    this.impl.recordFailure(credential, status, error);
  }

  public recordQuotaExhausted(providerId: string, accountId: string, usedPercent: number): void {
    this.impl.recordQuotaExhausted(providerId, accountId, usedPercent);
  }

  public getQuotaStatus(providerId: string, accountId: string): { exhaustedAt: number | null; usedPercent: number | null } {
    return this.impl.getQuotaStatus(providerId, accountId);
  }

  public isQuotaExhausted(providerId: string, accountId: string, cooldownMs: number = 300_000): boolean {
    return this.impl.isQuotaExhausted(providerId, accountId, cooldownMs);
  }

  public getGrowingCooldown(providerId: string, accountId: string, baseCooldownMs: number): number {
    return this.impl.getGrowingCooldown(providerId, accountId, baseCooldownMs);
  }

  public resetQuotaExhausted(providerId: string, accountId: string): void {
    this.impl.resetQuotaExhausted(providerId, accountId);
  }

  public getHealthScore(providerId: string, accountId: string, expiresAt?: number): number {
    return this.impl.getHealthScore(providerId, accountId, expiresAt);
  }

  public getAllHealthScores(): HealthScore[] {
    return this.impl.getAllHealthScores();
  }

  public sortCredentialsByHealth(credentials: readonly ProviderCredential[]): ProviderCredential[] {
    return this.impl.sortCredentialsByHealth(credentials);
  }

  public flushPendingWrites(): Promise<void> {
    return this.impl.flushPendingWrites();
  }

  public close(): Promise<void> {
    return this.impl.close();
  }
}
