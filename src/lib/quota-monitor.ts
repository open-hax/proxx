import type { CredentialStoreLike } from "./credential-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

export interface QuotaMonitorConfig {
  readonly checkIntervalMs: number;
  readonly batchSize: number;
  readonly providerId: string;
  readonly quotaWarningThreshold: number;
  readonly quotaCriticalThreshold: number;
}

export const DEFAULT_QUOTA_MONITOR_CONFIG: QuotaMonitorConfig = kernels.quotaMonitorDefaultConfig();

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

export interface QuotaMonitorLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface QuotaCooldownController {
  setAccountCooldownUntil(providerId: string, accountId: string, cooldownUntil: number): void;
  clearAccountCooldown(providerId: string, accountId: string): void;
}

/**
 * Background OpenAI quota checking. The state machine (what counts as
 * exhausted, which cooldown a quota implies, which effects a snapshot calls
 * for) is CLJS (`proxx.quota.monitor`); `proxx.runtime.quota-monitor` owns the
 * state atom, timers and side effects.
 */
export interface QuotaMonitorApi {
  start(): void;
  stop(): void;
  checkQuotas(): Promise<void>;
  refreshAccountQuota(accountId: string): Promise<QuotaStatusRecord | undefined>;
  tracksProvider(providerId: string): boolean;
  getQuotaStatus(accountId: string): QuotaStatusRecord | undefined;
  getAllQuotaStatuses(): QuotaStatusRecord[];
  isAccountExhausted(accountId: string): boolean;
  markAccountExhausted(accountId: string): void;
  /** Quota-derived wait for an account recorded as exhausted; undefined otherwise. */
  getCooldownMs(accountId: string): number | undefined;
  /**
   * Quota-derived cooldown regardless of exhaustion status: use when the account
   * is already known to be rate-limited and the quota data says *how long*.
   */
  getCooldownMsFromQuota(accountId: string): number | undefined;
}

export type QuotaMonitor = QuotaMonitorApi;

/** `new QuotaMonitor(...)` builds the monitor; a constructor returning an object yields it. */
export const QuotaMonitor = function QuotaMonitor(
  credentialStore: CredentialStoreLike,
  logger: QuotaMonitorLogger,
  config: Partial<QuotaMonitorConfig> = {},
  healthStore?: AccountHealthStore,
  cooldownController?: QuotaCooldownController,
): QuotaMonitorApi {
  return kernels.createQuotaMonitor(policyManifestPath(), credentialStore, logger, config, healthStore, cooldownController);
} as unknown as new (
  credentialStore: CredentialStoreLike,
  logger: QuotaMonitorLogger,
  config?: Partial<QuotaMonitorConfig>,
  healthStore?: AccountHealthStore,
  cooldownController?: QuotaCooldownController,
) => QuotaMonitorApi;
