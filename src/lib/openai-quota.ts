import type { CredentialAccountView, CredentialStoreLike } from "./credential-store.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * OpenAI account quota snapshots and liveness probes.
 *
 * Quota parsing and every verdict are pure CLJS (`proxx.quota.openai`); the
 * usage/token fetches, workspace retry and credential persistence are sequenced
 * by `proxx.runtime.quota`. Endpoints and timeouts are the manifest's
 * `:provider-quota-profile` contract.
 */
export interface OpenAiQuotaWindow {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly resetAfterSeconds: number | null;
  readonly limitWindowSeconds: number | null;
}

export interface OpenAiQuotaRateLimit {
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  readonly primaryWindow: OpenAiQuotaWindow | null;
  readonly secondaryWindow: OpenAiQuotaWindow | null;
}

export interface OpenAiQuotaAccountSnapshot {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly status: "ok" | "error";
  readonly fetchedAt: string;
  readonly fiveHour: OpenAiQuotaWindow | null;
  readonly weekly: OpenAiQuotaWindow | null;
  readonly rateLimit: OpenAiQuotaRateLimit | null;
  readonly codeReviewRateLimit: OpenAiQuotaRateLimit | null;
  readonly error?: string;
}

export interface OpenAiQuotaSnapshotResponse {
  readonly generatedAt: string;
  readonly accounts: readonly OpenAiQuotaAccountSnapshot[];
}

export interface OpenAiAccountProbeResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly testedAt: string;
  readonly model: string;
  readonly expectedText: string;
  readonly status: "ok" | "error";
  readonly ok: boolean;
  readonly matchesExpectedOutput: boolean;
  readonly outputText?: string;
  readonly upstreamStatus?: number;
  readonly errorCode?: string;
  readonly message: string;
}

interface LoggerLike {
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
}

export interface OpenAiQuotaFetchOptions {
  readonly providerId: string;
  readonly accountId?: string;
  readonly accounts?: readonly CredentialAccountView[];
  readonly fetchFn?: typeof fetch;
  readonly logger?: LoggerLike;
}

export interface OpenAiProbeOptions {
  readonly providerId: string;
  readonly accountId: string;
  readonly openAiBaseUrl: string;
  readonly openAiResponsesPath: string;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
  readonly logger?: LoggerLike;
}

export function fetchOpenAiQuotaSnapshots(
  credentialStore: CredentialStoreLike,
  options: OpenAiQuotaFetchOptions,
): Promise<OpenAiQuotaSnapshotResponse> {
  return kernels.fetchOpenAiQuotaSnapshots(policyManifestPath(), credentialStore, options);
}

export function probeOpenAiAccount(
  credentialStore: CredentialStoreLike,
  options: OpenAiProbeOptions,
): Promise<OpenAiAccountProbeResult> {
  return kernels.probeOpenAiAccount(policyManifestPath(), credentialStore, options);
}
