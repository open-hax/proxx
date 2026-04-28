import type { CredentialStoreLike } from "./credential-store.js";
import { fetchOpenAiQuotaSnapshots, type OpenAiQuotaAccountSnapshot } from "./openai-quota.js";
import type { AccountHealthStore } from "./db/account-health-store.js";

export interface QuotaMonitorConfig {
  readonly checkIntervalMs: number;
  readonly batchSize: number;
  readonly providerId: string;
  readonly quotaWarningThreshold: number;
  readonly quotaCriticalThreshold: number;
}

export const DEFAULT_QUOTA_MONITOR_CONFIG: QuotaMonitorConfig = {
  checkIntervalMs: 20 * 60 * 1000,
  batchSize: 10,
  providerId: "openai",
  quotaWarningThreshold: 90,
  quotaCriticalThreshold: 98,
};

export interface QuotaStatusRecord {
  accountId: string;
  providerId: string;
  fiveHourUsedPercent: number | null;
  weeklyUsedPercent: number | null;
  fiveHourResetsAt: string | null;
  fiveHourResetAfterSeconds: number | null;
  weeklyResetsAt: string | null;
  weeklyResetAfterSeconds: number | null;
  isExhausted: boolean;
  fetchedAt: number;
}

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface QuotaCooldownController {
  setAccountCooldownUntil(providerId: string, accountId: string, cooldownUntil: number): void;
  clearAccountCooldown(providerId: string, accountId: string): void;
}

export class QuotaMonitor {
  private readonly config: QuotaMonitorConfig;
  private readonly logger: Logger;
  private readonly credentialStore: CredentialStoreLike;
  private readonly healthStore?: AccountHealthStore;
  private readonly cooldownController?: QuotaCooldownController;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastQuotaStatus = new Map<string, QuotaStatusRecord>();
  private knownExhaustedAccounts = new Set<string>();

  public constructor(
    credentialStore: CredentialStoreLike,
    logger: Logger,
    config: Partial<QuotaMonitorConfig> = {},
    healthStore?: AccountHealthStore,
    cooldownController?: QuotaCooldownController,
  ) {
    this.config = { ...DEFAULT_QUOTA_MONITOR_CONFIG, ...config };
    this.logger = logger;
    this.credentialStore = credentialStore;
    this.healthStore = healthStore;
    this.cooldownController = cooldownController;
  }

  public start(): void {
    if (this.checkTimer) {
      return;
    }

    this.stopped = false;

    this.logger.info({ intervalMs: this.config.checkIntervalMs }, "quota-monitor: starting background quota checking");

    this.checkTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.checkQuotas();
      } catch (error) {
        this.logger.error({ error: String(error) }, "quota-monitor: background quota check failed");
      }
    }, this.config.checkIntervalMs);

    this.checkTimer.unref?.();

    setTimeout(() => {
      if (!this.stopped) {
        this.checkQuotas().catch((err) => {
          this.logger.error({ error: String(err) }, "quota-monitor: initial quota check failed");
        });
      }
    }, 10000);
  }

  public stop(): void {
    this.stopped = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  public async checkQuotas(): Promise<void> {
    const snapshots = await fetchOpenAiQuotaSnapshots(this.credentialStore, {
      providerId: this.config.providerId,
      fetchFn: fetch,
    });

    let checkedCount = 0;
    let exhaustedCount = 0;
    let warningCount = 0;
    let resetCount = 0;

    const newExhaustedAccounts = new Set<string>();

    for (const account of snapshots.accounts) {
      const previousStatus = this.lastQuotaStatus.get(account.accountId);
      const status = this.applySnapshot(account);

      checkedCount++;

      if (status.record.isExhausted) {
        exhaustedCount++;
        newExhaustedAccounts.add(account.accountId);
      } else if (status.isWarning) {
        warningCount++;
      }

      if (previousStatus?.isExhausted && !status.record.isExhausted) {
        resetCount++;
      }
    }

    this.knownExhaustedAccounts = newExhaustedAccounts;

    if (checkedCount > 0) {
      this.logger.info(
        { checked: checkedCount, exhausted: exhaustedCount, warning: warningCount, reset: resetCount },
        "quota-monitor: quota check completed",
      );
    }
  }

  public async refreshAccountQuota(accountId: string): Promise<QuotaStatusRecord | undefined> {
    const normalizedAccountId = accountId.trim();
    if (normalizedAccountId.length === 0) {
      return undefined;
    }

    const snapshots = await fetchOpenAiQuotaSnapshots(this.credentialStore, {
      providerId: this.config.providerId,
      accountId: normalizedAccountId,
      fetchFn: fetch,
    });

    const snapshot = snapshots.accounts[0];
    if (!snapshot) {
      return this.lastQuotaStatus.get(normalizedAccountId);
    }

    return this.applySnapshot(snapshot).record;
  }

  public tracksProvider(providerId: string): boolean {
    return providerId.trim().toLowerCase() === this.config.providerId.toLowerCase();
  }

  private computeQuotaStatus(snapshot: OpenAiQuotaAccountSnapshot): {
    fiveHourUsedPercent: number | null;
    weeklyUsedPercent: number | null;
    isExhausted: boolean;
    isWarning: boolean;
  } {
    const fiveHourUsedPercent = snapshot.fiveHour?.usedPercent ?? snapshot.weekly?.usedPercent ?? null;
    const weeklyUsedPercent = snapshot.weekly?.usedPercent ?? fiveHourUsedPercent ?? null;
    const rateLimitReached = snapshot.rateLimit?.limitReached === true || snapshot.rateLimit?.allowed === false;

    const isExhausted = rateLimitReached
      || (fiveHourUsedPercent !== null && fiveHourUsedPercent >= this.config.quotaCriticalThreshold)
      || (weeklyUsedPercent !== null && weeklyUsedPercent >= this.config.quotaCriticalThreshold);
    const isWarning = !isExhausted && (
      (fiveHourUsedPercent !== null && fiveHourUsedPercent >= this.config.quotaWarningThreshold)
      || (weeklyUsedPercent !== null && weeklyUsedPercent >= this.config.quotaWarningThreshold)
    );

    return { fiveHourUsedPercent, weeklyUsedPercent, isExhausted, isWarning };
  }

  private applySnapshot(snapshot: OpenAiQuotaAccountSnapshot): {
    readonly record: QuotaStatusRecord;
    readonly isWarning: boolean;
  } {
    const previousStatus = this.lastQuotaStatus.get(snapshot.accountId);
    const status = this.computeQuotaStatus(snapshot);
    const record: QuotaStatusRecord = {
      accountId: snapshot.accountId,
      providerId: this.config.providerId,
      fiveHourUsedPercent: status.fiveHourUsedPercent,
      weeklyUsedPercent: status.weeklyUsedPercent,
      fiveHourResetsAt: snapshot.fiveHour?.resetsAt ?? null,
      fiveHourResetAfterSeconds: snapshot.fiveHour?.resetAfterSeconds ?? null,
      weeklyResetsAt: snapshot.weekly?.resetsAt ?? null,
      weeklyResetAfterSeconds: snapshot.weekly?.resetAfterSeconds ?? null,
      isExhausted: status.isExhausted,
      fetchedAt: Date.now(),
    };

    this.lastQuotaStatus.set(snapshot.accountId, record);

    if (status.isExhausted) {
      this.knownExhaustedAccounts.add(snapshot.accountId);
      this.recordQuotaExhaustion(snapshot, record);
    } else {
      this.knownExhaustedAccounts.delete(snapshot.accountId);
      if (previousStatus?.isExhausted) {
        this.recordQuotaReset(snapshot);
      }
    }

    return { record, isWarning: status.isWarning };
  }

  private recordQuotaExhaustion(snapshot: OpenAiQuotaAccountSnapshot, status: QuotaStatusRecord): void {
    const usedPercent = snapshot.fiveHour?.usedPercent ?? snapshot.weekly?.usedPercent ?? 100;
    this.healthStore?.recordQuotaExhausted(
      this.config.providerId,
      snapshot.accountId,
      usedPercent,
    );

    const cooldownUntil = this.resolveCooldownUntil(status);
    if (cooldownUntil !== undefined) {
      this.cooldownController?.setAccountCooldownUntil(this.config.providerId, snapshot.accountId, cooldownUntil);
    }
  }

  private recordQuotaReset(snapshot: OpenAiQuotaAccountSnapshot): void {
    this.healthStore?.resetQuotaExhausted(
      this.config.providerId,
      snapshot.accountId,
    );
    this.cooldownController?.clearAccountCooldown(this.config.providerId, snapshot.accountId);

    this.logger.info(
      { accountId: snapshot.accountId, usedPercent: snapshot.fiveHour?.usedPercent ?? snapshot.weekly?.usedPercent },
      "quota-monitor: detected quota reset, resetting account health",
    );
  }

  public getQuotaStatus(accountId: string): QuotaStatusRecord | undefined {
    return this.lastQuotaStatus.get(accountId);
  }

  public getAllQuotaStatuses(): QuotaStatusRecord[] {
    return [...this.lastQuotaStatus.values()];
  }

  public isAccountExhausted(accountId: string): boolean {
    return this.knownExhaustedAccounts.has(accountId);
  }

  public markAccountExhausted(accountId: string): void {
    this.knownExhaustedAccounts.add(accountId);
  }

  public getCooldownMs(accountId: string): number | undefined {
    const status = this.lastQuotaStatus.get(accountId);
    if (!status || !status.isExhausted) {
      return undefined;
    }
    return this.getCooldownMsFromQuotaStatus(status);
  }

  /**
   * Return the quota-derived cooldown for an account regardless of exhaustion status.
   * Use this when the account is already known to be rate-limited (e.g. 429 response)
   * and we need the quota data to determine *how long* to wait.
   */
  public getCooldownMsFromQuota(accountId: string): number | undefined {
    const status = this.lastQuotaStatus.get(accountId);
    if (!status) {
      return undefined;
    }
    return this.getCooldownMsFromQuotaStatus(status);
  }

  private getCooldownMsFromQuotaStatus(status: QuotaStatusRecord): number | undefined {
    if (status.fiveHourResetAfterSeconds !== null) {
      return status.fiveHourResetAfterSeconds * 1000;
    }
    if (status.weeklyResetAfterSeconds !== null) {
      return status.weeklyResetAfterSeconds * 1000;
    }
    if (status.fiveHourResetsAt) {
      const resetTime = new Date(status.fiveHourResetsAt).getTime();
      const now = Date.now();
      const remaining = resetTime - now;
      if (remaining > 0) {
        return remaining;
      }
    }
    if (status.weeklyResetsAt) {
      const resetTime = new Date(status.weeklyResetsAt).getTime();
      const now = Date.now();
      const remaining = resetTime - now;
      if (remaining > 0) {
        return remaining;
      }
    }
    return undefined;
  }

  private resolveCooldownUntil(status: QuotaStatusRecord): number | undefined {
    const cooldownMs = this.getCooldownMs(status.accountId);
    if (!cooldownMs) {
      return undefined;
    }

    return Date.now() + cooldownMs;
  }
}
