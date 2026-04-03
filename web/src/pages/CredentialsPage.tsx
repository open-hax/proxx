import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addApiKeyCredential,
  getApiOrigin,
  getOpenAiCredentialQuota,
  getOpenAiPromptCacheAudit,
  listCredentials,
  listRequestLogs,
  pollFactoryDeviceOAuth,
  pollOpenAiDeviceOAuth,
  type CredentialAccount,
  type CredentialProvider,
  type CredentialQuotaAccountSummary,
  type CredentialQuotaRateLimit,
  type CredentialQuotaOverview,
  type CredentialQuotaWindow,
  type KeyPoolStatus,
  type OpenAiAccountProbeResult,
  type PromptCacheAuditOverview,
  type ProviderRequestLogSummary,
  type RequestLogEntry,
  probeOpenAiCredentialAccount,
  removeCredential,
  startFactoryBrowserOAuth,
  startFactoryDeviceOAuth,
  startOpenAiBrowserOAuth,
  startOpenAiDeviceOAuth,
} from "../lib/api";
import { formatAuthType, formatRequestOrigin } from "../lib/format";
import { useStoredState } from "../lib/use-stored-state";

interface DeviceAuthState {
  readonly provider: "openai" | "factory";
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}

const LS_CREDENTIALS_REVEAL_SECRETS = "open-hax-proxy.ui.credentials.revealSecrets";
const LS_CREDENTIALS_GROUPING = "open-hax-proxy.ui.credentials.grouping";
const LS_CREDENTIALS_ACCOUNT_SEARCH = "open-hax-proxy.ui.credentials.accountSearch";
const LS_CREDENTIALS_LOG_PROVIDER = "open-hax-proxy.ui.credentials.logProvider";
const LS_CREDENTIALS_LOG_ACCOUNT = "open-hax-proxy.ui.credentials.logAccount";

function validateBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  // Backwards compat: older versions might store as strings.
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
  }

  return undefined;
}

function validateString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateAccountGrouping(value: unknown): AccountGrouping | undefined {
  return value === "provider" || value === "plan" || value === "domain" ? value : undefined;
}

type AccountGrouping = "provider" | "plan" | "domain";

interface AccountEntry {
  readonly providerId: string;
  readonly providerAuthType: CredentialProvider["authType"];
  readonly account: CredentialAccount;
}

interface AccountDiagnostics {
  readonly needsReauth: boolean;
  readonly duplicateCount: number;
}

function compactMiddle(value: string, head: number = 8, tail: number = 6): string {
  if (value.length <= head + tail + 1) {
    return value;
  }

  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function titleCasePlan(planType?: string): string | null {
  if (!planType) {
    return null;
  }

  return planType
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatExpiryBadge(expiresAt?: number): string | null {
  if (typeof expiresAt !== "number") {
    return null;
  }

  return new Date(expiresAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatQuotaTimestamp(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

function formatResetSummary(window: CredentialQuotaWindow | null): string | null {
  if (!window) {
    return null;
  }

  const seconds = typeof window.resetAfterSeconds === "number"
    ? Math.max(0, Math.round(window.resetAfterSeconds))
    : window.resetsAt
      ? Math.max(0, Math.round((new Date(window.resetsAt).getTime() - Date.now()) / 1000))
      : null;

  if (seconds === null) {
    return null;
  }

  if (seconds >= 24 * 60 * 60) {
    const date = window.resetsAt ? new Date(window.resetsAt) : null;
    return date ? `resets ${date.toLocaleString()}` : `resets in ${Math.floor(seconds / 86400)}d`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }

  return `resets in ${minutes}m`;
}

function formatQuotaWindowLabel(window: CredentialQuotaWindow | null, fallback: string): string {
  const seconds = window?.limitWindowSeconds ?? null;
  if (seconds === null || seconds <= 0) {
    return fallback;
  }

  if (seconds % 86400 === 0) {
    const days = Math.round(seconds / 86400);
    return `${days}d window`;
  }

  if (seconds % 3600 === 0) {
    const hours = Math.round(seconds / 3600);
    return `${hours}h window`;
  }

  if (seconds % 60 === 0) {
    const minutes = Math.round(seconds / 60);
    return `${minutes}m window`;
  }

  return `${seconds}s window`;
}

function formatQuotaRateLimitStatus(rateLimit: CredentialQuotaRateLimit | null): string {
  if (!rateLimit) {
    return "Unknown";
  }

  if (rateLimit.allowed === true) {
    return "Allowed";
  }

  if (rateLimit.allowed === false || rateLimit.limitReached === true) {
    return "Blocked";
  }

  return "Unknown";
}

function quotaRateLimitBadgeClass(rateLimit: CredentialQuotaRateLimit | null): string {
  if (rateLimit?.allowed === true) {
    return "credentials-badge-accent";
  }

  if (rateLimit?.allowed === false || rateLimit?.limitReached === true) {
    return "credentials-badge-danger";
  }

  return "credentials-badge-muted";
}

function probeBadgeClass(result: OpenAiAccountProbeResult | undefined): string {
  if (!result) {
    return "credentials-badge-muted";
  }

  return result.ok ? "credentials-badge-accent" : "credentials-badge-danger";
}

function formatAggregatePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

function quotaBadgeClassFromPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "credentials-badge-muted";
  }

  if (value <= 15) {
    return "credentials-badge-danger";
  }

  if (value <= 40) {
    return "credentials-badge-warning";
  }

  return "credentials-badge-accent";
}

function quotaToneClass(remainingPercent: number | null): string {
  if (remainingPercent === null) {
    return "credentials-quota-fill-neutral";
  }

  if (remainingPercent <= 15) {
    return "credentials-quota-fill-danger";
  }

  if (remainingPercent <= 40) {
    return "credentials-quota-fill-warn";
  }

  return "credentials-quota-fill-good";
}

function formatServiceTier(entry: RequestLogEntry): string {
  if (!entry.serviceTier) {
    return "standard";
  }

  if (entry.serviceTierSource === "fast_mode") {
    return "fast mode";
  }

  if (entry.serviceTier === "priority") {
    return "priority";
  }

  return entry.serviceTier.replace(/[_-]+/g, " ");
}

function formatRouteLabel(entry: RequestLogEntry): string {
  if (entry.routeKind === "local") {
    return "local";
  }

  const peer = entry.routedPeerLabel ?? entry.routedPeerId ?? "unknown-peer";
  return `${entry.routeKind} → ${peer}`;
}

function sortAccounts(accounts: readonly CredentialAccount[]): CredentialAccount[] {
  return [...accounts].sort((left, right) => {
    const leftLabel = (left.email ?? left.displayName ?? left.id).toLowerCase();
    const rightLabel = (right.email ?? right.displayName ?? right.id).toLowerCase();
    return leftLabel.localeCompare(rightLabel);
  });
}



function getEmailDomain(email?: string): string | null {
  if (!email) {
    return null;
  }

  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0 || atIndex === email.length - 1) {
    return null;
  }

  return email.slice(atIndex + 1).toLowerCase();
}

function accountSearchBlob(entry: AccountEntry): string {
  const planLabel = titleCasePlan(entry.account.planType) ?? "";
  const emailDomain = getEmailDomain(entry.account.email) ?? "";

  return [
    entry.providerId,
    entry.account.id,
    entry.account.displayName,
    entry.account.email,
    entry.account.subject,
    entry.account.chatgptAccountId,
    entry.account.planType,
    planLabel,
    emailDomain,
    entry.account.secretPreview,
    formatAuthType(entry.account.authType),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function hasRefreshToken(account: CredentialAccount): boolean {
  const visibleRefreshToken = account.refreshToken ?? account.refreshTokenPreview;
  return typeof visibleRefreshToken === "string" && visibleRefreshToken.trim().length > 0;
}

function errorSuggestsReauth(error?: string): boolean {
  const normalized = error?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.includes("provided authentication token is expired")
    || normalized.includes("please try signing in again")
    || normalized.includes("refresh token has already been used")
    || normalized.includes("refresh token expired")
    || normalized.includes("refresh_token_expired")
    || normalized.includes("refresh_token_reused")
    || normalized.includes("signing in again");
}

function humanIdentityKey(entry: AccountEntry): string | null {
  const subject = entry.account.subject?.trim();
  if (subject) {
    return `${entry.providerId}:subject:${subject}`;
  }

  const email = entry.account.email?.trim().toLowerCase();
  if (email) {
    return `${entry.providerId}:email:${email}`;
  }

  return null;
}

function humanIdentityLabel(entry: AccountEntry): string | null {
  if (entry.account.email) {
    return entry.account.email;
  }

  if (entry.account.subject) {
    return compactMiddle(entry.account.subject, 12, 8);
  }

  return null;
}

export function CredentialsPage(): JSX.Element {
  // NOTE: Persisting revealSecrets can be risky on shared machines; you asked
  // for persistence so we do it, but it will auto-load on refresh.
  const [revealSecrets, setRevealSecrets] = useStoredState(LS_CREDENTIALS_REVEAL_SECRETS, false, validateBoolean);
  const [providers, setProviders] = useState<CredentialProvider[]>([]);
  const [keyPoolStatuses, setKeyPoolStatuses] = useState<Record<string, KeyPoolStatus>>({});
  const [requestLogSummary, setRequestLogSummary] = useState<Record<string, ProviderRequestLogSummary>>({});
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useStoredState(LS_CREDENTIALS_LOG_PROVIDER, "", validateString);
  const [selectedAccount, setSelectedAccount] = useStoredState(LS_CREDENTIALS_LOG_ACCOUNT, "", validateString);
  const [apiKeyProvider, setApiKeyProvider] = useState("vivgrid");
  const [apiKeyAccount, setApiKeyAccount] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthState | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [accountSearch, setAccountSearch] = useStoredState(LS_CREDENTIALS_ACCOUNT_SEARCH, "", validateString);
  const [accountGrouping, setAccountGrouping] = useStoredState<AccountGrouping>(LS_CREDENTIALS_GROUPING, "provider", validateAccountGrouping);
  const [showReauthOnly, setShowReauthOnly] = useState(false);
  const [quotaOverview, setQuotaOverview] = useState<CredentialQuotaOverview | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [promptCacheAudit, setPromptCacheAudit] = useState<PromptCacheAuditOverview | null>(null);
  const [accountProbeResults, setAccountProbeResults] = useState<Record<string, OpenAiAccountProbeResult>>({});
  const [accountProbeLoading, setAccountProbeLoading] = useState<Record<string, boolean>>({});
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserOAuthWatchRef = useRef<number | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const hasLoadedQuotaRef = useRef(false);
  const devicePollingRef = useRef(false);

  const refreshCredentials = useCallback(async () => {
    const payload = await listCredentials(revealSecrets);
    setProviders(payload.providers);
    setKeyPoolStatuses(payload.keyPoolStatuses);
    setRequestLogSummary(payload.requestLogSummary);
  }, [revealSecrets]);

  const refreshLogs = useCallback(async () => {
    const entries = await listRequestLogs({
      providerId: selectedProvider || undefined,
      accountId: selectedAccount || undefined,
      limit: 250,
    });
    setLogs(entries);
  }, [selectedAccount, selectedProvider]);

  const refreshQuota = useCallback(async () => {
    setQuotaLoading(true);
    setQuotaError(null);

    try {
      const nextQuota = await getOpenAiCredentialQuota();
      setQuotaOverview(nextQuota);
    } catch (nextError) {
      setQuotaError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setQuotaLoading(false);
    }
  }, []);

  const refreshPromptCacheAudit = useCallback(async () => {
    try {
      const nextAudit = await getOpenAiPromptCacheAudit(40);
      setPromptCacheAudit(nextAudit);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  useEffect(() => {
    void refreshCredentials().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }, [refreshCredentials]);

  useEffect(() => {
    void refreshLogs().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    });
  }, [refreshLogs]);

  useEffect(() => {
    if (hasLoadedQuotaRef.current || providers.length === 0) {
      return;
    }

    hasLoadedQuotaRef.current = true;
    void refreshQuota();
    void refreshPromptCacheAudit();
  }, [providers.length, refreshPromptCacheAudit, refreshQuota]);

  useEffect(() => {
    return () => {
      if (browserOAuthWatchRef.current !== null) {
        window.clearInterval(browserOAuthWatchRef.current);
        browserOAuthWatchRef.current = null;
      }

      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const allAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      for (const account of provider.accounts) {
        ids.add(account.id);
      }
    }
    return [...ids].sort();
  }, [providers]);

  const sortedProviders = useMemo(() => {
    return [...providers]
      .map((provider) => ({
        ...provider,
        accounts: sortAccounts(provider.accounts),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }, [providers]);

  const flatAccounts = useMemo<AccountEntry[]>(() => {
    return sortedProviders.flatMap((provider) =>
      provider.accounts.map((account) => ({
        providerId: provider.id,
        providerAuthType: provider.authType,
        account,
      })),
    );
  }, [sortedProviders]);

  const quotaByAccount = useMemo(() => {
    const entries = new Map<string, CredentialQuotaAccountSummary>();
    for (const account of quotaOverview?.accounts ?? []) {
      entries.set(`${account.providerId}:${account.accountId}`, account);
    }
    return entries;
  }, [quotaOverview]);

  const openAiQuotaPool = useMemo(() => {
    const allOpenAiQuotaAccounts = (quotaOverview?.accounts ?? []).filter((account) => account.providerId === "openai");
    if (allOpenAiQuotaAccounts.length === 0) {
      return null;
    }

    const okAccounts = allOpenAiQuotaAccounts.filter((account) => account.status === "ok");
    const errorAccounts = allOpenAiQuotaAccounts.filter((account) => account.status === "error");
    const generalWindows = okAccounts
      .map((account) => account.rateLimit?.primaryWindow ?? account.fiveHour)
      .filter((window): window is CredentialQuotaWindow => window != null);
    const codeReviewWindows = okAccounts
      .map((account) => account.codeReviewRateLimit?.primaryWindow)
      .filter((window): window is CredentialQuotaWindow => window != null);
    const generalRemainingValues = generalWindows
      .map((window) => window.remainingPercent)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const codeReviewRemainingValues = codeReviewWindows
      .map((window) => window.remainingPercent)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const generalAvailableCount = okAccounts.filter((account) => account.rateLimit?.allowed === true).length;
    const generalBlockedAccounts = okAccounts.filter((account) => account.rateLimit?.allowed === false || account.rateLimit?.limitReached === true);
    const codeReviewAvailableCount = okAccounts.filter((account) => account.codeReviewRateLimit?.allowed === true).length;
    const sortWindowByReset = (left: CredentialQuotaWindow, right: CredentialQuotaWindow): number => {
      const leftReset = left.resetAfterSeconds ?? (left.resetsAt ? Math.max(0, Math.round((new Date(left.resetsAt).getTime() - Date.now()) / 1000)) : Number.POSITIVE_INFINITY);
      const rightReset = right.resetAfterSeconds ?? (right.resetsAt ? Math.max(0, Math.round((new Date(right.resetsAt).getTime() - Date.now()) / 1000)) : Number.POSITIVE_INFINITY);
      return leftReset - rightReset;
    };

    const nextResetWindow = [
      ...generalBlockedAccounts
        .map((account) => account.rateLimit?.primaryWindow ?? account.fiveHour)
        .filter((window): window is CredentialQuotaWindow => window != null),
      ...okAccounts
        .map((account) => account.rateLimit?.primaryWindow ?? account.fiveHour)
        .filter((window): window is CredentialQuotaWindow => window != null),
    ].sort(sortWindowByReset)[0] ?? null;

    const average = (values: readonly number[]): number | null => {
      if (values.length === 0) {
        return null;
      }

      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    return {
      totalAccounts: allOpenAiQuotaAccounts.length,
      okAccounts: okAccounts.length,
      errorAccounts: errorAccounts.length,
      generalCombinedRemainingPercent: average(generalRemainingValues),
      codeReviewCombinedRemainingPercent: average(codeReviewRemainingValues),
      generalAvailableCount,
      generalBlockedCount: generalBlockedAccounts.length,
      codeReviewAvailableCount,
      nextResetWindow,
      windowLabel: formatQuotaWindowLabel(generalWindows[0] ?? null, "Primary window"),
      codeReviewWindowLabel: formatQuotaWindowLabel(codeReviewWindows[0] ?? null, "Primary window"),
    };
  }, [quotaOverview]);

  const cacheStabilityWatchRows = useMemo(() => {
    if (!promptCacheAudit) {
      return [];
    }

    return promptCacheAudit.rows
      .map((row) => {
        const cacheRate = row.promptTokens > 0 ? (row.cachedPromptTokens / row.promptTokens) * 100 : 0;
        return {
          ...row,
          cacheRate,
        };
      })
      .filter((row) => row.successfulAccountCount === 1)
      .filter((row) => row.shapeFingerprintCount === 1)
      .filter((row) => row.successfulRequestCount >= 4)
      .filter((row) => row.promptTokens >= 10_000)
      .sort((left, right) => {
        if (left.cacheRate !== right.cacheRate) {
          return left.cacheRate - right.cacheRate;
        }

        if (right.promptTokens !== left.promptTokens) {
          return right.promptTokens - left.promptTokens;
        }

        return left.promptCacheKeyHash.localeCompare(right.promptCacheKeyHash);
      })
      .slice(0, 8);
  }, [promptCacheAudit]);

  const sortAccountEntries = useCallback((entries: readonly AccountEntry[]): AccountEntry[] => {
    const now = Date.now();
    const metricsFor = (entry: AccountEntry) => {
      const quota = quotaByAccount.get(`${entry.providerId}:${entry.account.id}`);
      const primaryWindow = quota?.rateLimit?.primaryWindow ?? quota?.fiveHour ?? null;
      const hasQuota = entry.providerId === "openai" && entry.account.authType === "oauth_bearer" && quota?.status === "ok" && primaryWindow !== null;
      const remainingPercent = primaryWindow?.remainingPercent ?? null;
      const resetSeconds = primaryWindow?.resetAfterSeconds
        ?? (primaryWindow?.resetsAt ? Math.max(0, Math.round((new Date(primaryWindow.resetsAt).getTime() - now) / 1000)) : Number.POSITIVE_INFINITY);
      const allowedRank = quota?.rateLimit?.allowed === true
        ? 0
        : quota?.rateLimit?.allowed === false || quota?.rateLimit?.limitReached === true
          ? 1
          : 2;

      return {
        hasQuota,
        remainingPercent,
        resetSeconds,
        allowedRank,
      };
    };

    return [...entries].sort((left, right) => {
      const leftMetrics = metricsFor(left);
      const rightMetrics = metricsFor(right);

      if (leftMetrics.hasQuota !== rightMetrics.hasQuota) {
        return leftMetrics.hasQuota ? -1 : 1;
      }

      if (leftMetrics.hasQuota && rightMetrics.hasQuota) {
        const leftRemaining = leftMetrics.remainingPercent ?? -1;
        const rightRemaining = rightMetrics.remainingPercent ?? -1;
        if (rightRemaining !== leftRemaining) {
          return rightRemaining - leftRemaining;
        }

        if (leftMetrics.allowedRank !== rightMetrics.allowedRank) {
          return leftMetrics.allowedRank - rightMetrics.allowedRank;
        }

        if (leftMetrics.resetSeconds !== rightMetrics.resetSeconds) {
          return leftMetrics.resetSeconds - rightMetrics.resetSeconds;
        }
      }

      const leftLabel = (left.account.email ?? left.account.displayName ?? left.account.id).toLowerCase();
      const rightLabel = (right.account.email ?? right.account.displayName ?? right.account.id).toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
  }, [quotaByAccount]);

  const accountDiagnostics = useMemo(() => {
    const now = Date.now();
    const identityGroups = new Map<string, { label: string; accountKeys: string[] }>();

    for (const entry of flatAccounts) {
      const identityKey = humanIdentityKey(entry);
      const identityLabel = humanIdentityLabel(entry);
      if (!identityKey || !identityLabel) {
        continue;
      }

      const group = identityGroups.get(identityKey) ?? { label: identityLabel, accountKeys: [] };
      group.accountKeys.push(`${entry.providerId}:${entry.account.id}`);
      identityGroups.set(identityKey, group);
    }

    const duplicateCountByAccount = new Map<string, number>();
    const duplicateGroups = [...identityGroups.values()]
      .filter((group) => group.accountKeys.length > 1)
      .sort((left, right) => left.label.localeCompare(right.label));

    for (const group of duplicateGroups) {
      for (const accountKey of group.accountKeys) {
        duplicateCountByAccount.set(accountKey, group.accountKeys.length);
      }
    }

    const diagnosticsByAccount = new Map<string, AccountDiagnostics>();
    let reauthRequiredCount = 0;
    let openAiOauthCount = 0;
    let humanIdentifiedOpenAiOauthCount = 0;

    for (const entry of flatAccounts) {
      const accountKey = `${entry.providerId}:${entry.account.id}`;
      const quota = quotaByAccount.get(accountKey);
      const isOpenAiOauth = entry.providerId === "openai" && entry.account.authType === "oauth_bearer";
      const tokenExpired = typeof entry.account.expiresAt === "number" && entry.account.expiresAt <= now;
      const needsReauth = isOpenAiOauth && (errorSuggestsReauth(quota?.error) || (tokenExpired && !hasRefreshToken(entry.account)));

      if (isOpenAiOauth) {
        openAiOauthCount += 1;
        if (entry.account.email || entry.account.subject) {
          humanIdentifiedOpenAiOauthCount += 1;
        }
      }

      if (needsReauth) {
        reauthRequiredCount += 1;
      }

      diagnosticsByAccount.set(accountKey, {
        needsReauth,
        duplicateCount: duplicateCountByAccount.get(accountKey) ?? 0,
      });
    }

    return {
      byAccount: diagnosticsByAccount,
      duplicateGroups,
      reauthRequiredCount,
      openAiOauthCount,
      humanIdentifiedOpenAiOauthCount,
    };
  }, [flatAccounts, quotaByAccount]);

  const normalizedAccountSearch = accountSearch.trim().toLowerCase();

  const filteredAccounts = useMemo(() => {
    const searchFiltered = normalizedAccountSearch.length === 0
      ? flatAccounts
      : flatAccounts.filter((entry) => accountSearchBlob(entry).includes(normalizedAccountSearch));

    if (!showReauthOnly) {
      return searchFiltered;
    }

    return searchFiltered.filter((entry) => accountDiagnostics.byAccount.get(`${entry.providerId}:${entry.account.id}`)?.needsReauth);
  }, [accountDiagnostics.byAccount, flatAccounts, normalizedAccountSearch, showReauthOnly]);

  const filteredProviders = useMemo(() => {
    const accountsByProvider = new Map<string, CredentialAccount[]>();
    for (const entry of filteredAccounts) {
      const current = accountsByProvider.get(entry.providerId) ?? [];
      current.push(entry.account);
      accountsByProvider.set(entry.providerId, current);
    }

    return sortedProviders
      .map((provider) => ({
        ...provider,
        accounts: sortAccounts(accountsByProvider.get(provider.id) ?? []),
      }))
      .filter((provider) => provider.accounts.length > 0);
  }, [filteredAccounts, sortedProviders]);

  const groupedAccountSections = useMemo(() => {
    if (accountGrouping === "provider") {
      return filteredProviders.map((provider) => ({
        key: provider.id,
        title: provider.id,
        description:
          provider.accounts.length === provider.accountCount
            ? `${provider.accountCount} account(s) connected`
            : `${provider.accounts.length} of ${provider.accountCount} account(s) shown`,
        badge: formatAuthType(provider.authType),
        badgeMuted: `${provider.accounts.length} shown`,
        accounts: sortAccountEntries(provider.accounts.map((account) => ({
          providerId: provider.id,
          providerAuthType: provider.authType,
          account,
        }))),
      }));
    }

    const groups = new Map<string, { title: string; description: string; accounts: AccountEntry[] }>();

    for (const entry of filteredAccounts) {
      const domain = getEmailDomain(entry.account.email);
      const planLabel = titleCasePlan(entry.account.planType);
      const key = accountGrouping === "plan"
        ? `plan:${entry.account.planType ?? "__none__"}`
        : `domain:${domain ?? "__none__"}`;
      const title = accountGrouping === "plan"
        ? (planLabel ?? "No plan")
        : (domain ?? "No email domain");
      const description = accountGrouping === "plan" ? "Plan grouping" : "Email domain grouping";
      const current = groups.get(key) ?? { title, description, accounts: [] };
      current.accounts.push(entry);
      groups.set(key, current);
    }

    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        title: value.title,
        description: `${value.accounts.length} account(s) · ${value.description}`,
        badge: accountGrouping === "plan" ? "Plan" : "Domain",
        badgeMuted: `${value.accounts.length} shown`,
        accounts: sortAccountEntries(value.accounts),
      }))
      .sort((left, right) => {
        if (left.title.startsWith("No ") && !right.title.startsWith("No ")) {
          return 1;
        }
        if (!left.title.startsWith("No ") && right.title.startsWith("No ")) {
          return -1;
        }
        return left.title.localeCompare(right.title);
      });
  }, [accountGrouping, filteredAccounts, filteredProviders, sortAccountEntries]);

  const providerHealth = useMemo(() => {
    const providerIds = new Set<string>([
      ...providers.map((provider) => provider.id),
      ...Object.keys(keyPoolStatuses),
      ...Object.keys(requestLogSummary),
    ]);

    return [...providerIds].sort().map((providerId) => ({
      providerId,
      keyPool: keyPoolStatuses[providerId],
      logs: requestLogSummary[providerId],
    }));
  }, [keyPoolStatuses, providers, requestLogSummary]);

  const duplicateSummary = useMemo(() => {
    if (accountDiagnostics.duplicateGroups.length === 0) {
      return "No possible duplicate identities detected";
    }

    const preview = accountDiagnostics.duplicateGroups
      .slice(0, 3)
      .map((group) => `${group.label} (${group.accountKeys.length})`)
      .join(", ");

    return accountDiagnostics.duplicateGroups.length > 3
      ? `Possible duplicates: ${preview}…`
      : `Possible duplicates: ${preview}`;
  }, [accountDiagnostics.duplicateGroups]);

  const handleApiKeySubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      if (apiKeyValue.trim().length === 0) {
        throw new Error("API key value is required");
      }

      const accountId = apiKeyAccount.trim();
      await addApiKeyCredential(apiKeyProvider.trim(), apiKeyValue.trim(), accountId.length > 0 ? accountId : undefined);
      setApiKeyValue("");
      setApiKeyAccount("");
      setStatus("API key saved.");
      await refreshCredentials();
      await refreshQuota();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  const startBrowserOAuth = async (target?: AccountEntry) => {
    setError(null);

    try {
      const payload = await startOpenAiBrowserOAuth(getApiOrigin(), target?.account.id);
      const authWindow = window.open(payload.authorizeUrl, "_blank");

      if (!authWindow) {
        throw new Error("Browser blocked the new tab. Allow popups and try again.");
      }

      if (browserOAuthWatchRef.current !== null) {
        window.clearInterval(browserOAuthWatchRef.current);
        browserOAuthWatchRef.current = null;
      }

      browserOAuthWatchRef.current = window.setInterval(() => {
        if (!authWindow.closed) {
          return;
        }

        if (browserOAuthWatchRef.current !== null) {
          window.clearInterval(browserOAuthWatchRef.current);
          browserOAuthWatchRef.current = null;
        }

        void refreshCredentials();
        void refreshQuota();
        setStatus(target
          ? `OpenAI reauth finished for ${target.account.email ?? target.account.displayName}. Credentials refreshed.`
          : "Browser OAuth flow finished. Credentials refreshed.");
      }, 750);

      setStatus(target
        ? `OpenAI reauth tab opened for ${target.account.email ?? target.account.displayName}. Sign into that same account to replace the old credential.`
        : "Browser OAuth tab opened. Finish sign-in to save credentials.");
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const startDeviceOAuth = async () => {
    setError(null);

    try {
      const payload = await startOpenAiDeviceOAuth();
      setDeviceAuth({ ...payload, provider: "openai" });
      setStatus(`Device auth started. Enter code ${payload.userCode}; polling continues automatically.`);
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const pollDeviceOAuth = useCallback(async () => {
    if (!deviceAuth || devicePollingRef.current) {
      return;
    }

    devicePollingRef.current = true;
    setDevicePolling(true);
    setError(null);

    try {
      const result = deviceAuth.provider === "factory"
        ? await pollFactoryDeviceOAuth(deviceAuth.deviceAuthId)
        : await pollOpenAiDeviceOAuth(deviceAuth.deviceAuthId, deviceAuth.userCode);
      if (result.state === "pending") {
        setStatus("Authorization is still pending.");
        return;
      }

      if (result.state === "failed") {
        setError(result.reason ?? "OAuth device poll failed");
        return;
      }

      const providerLabel = deviceAuth.provider === "factory" ? "Factory.ai" : "OpenAI";
      setStatus(`${providerLabel} OAuth account saved from device flow.`);
      setDeviceAuth(null);
      await refreshCredentials();
      await refreshQuota();
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : String(pollError));
    } finally {
      devicePollingRef.current = false;
      setDevicePolling(false);
    }
  }, [deviceAuth, refreshCredentials, refreshQuota]);

  useEffect(() => {
    if (!deviceAuth) {
      return;
    }

    const intervalMs = Math.max(deviceAuth.intervalMs + 3000, 3000);
    const timer = window.setInterval(() => {
      void pollDeviceOAuth();
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [deviceAuth, pollDeviceOAuth]);

  const startFactoryBrowser = async () => {
    setError(null);

    try {
      const payload = await startFactoryBrowserOAuth(getApiOrigin());
      const authWindow = window.open(payload.authorizeUrl, "_blank");

      if (!authWindow) {
        throw new Error("Browser blocked the new tab. Allow popups and try again.");
      }

      if (browserOAuthWatchRef.current !== null) {
        window.clearInterval(browserOAuthWatchRef.current);
        browserOAuthWatchRef.current = null;
      }

      browserOAuthWatchRef.current = window.setInterval(() => {
        if (!authWindow.closed) {
          return;
        }

        if (browserOAuthWatchRef.current !== null) {
          window.clearInterval(browserOAuthWatchRef.current);
          browserOAuthWatchRef.current = null;
        }

        void refreshCredentials();
        setStatus("Factory.ai browser OAuth flow finished. Credentials refreshed.");
      }, 750);

      setStatus("Factory.ai OAuth tab opened. Finish sign-in to save credentials.");
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const startFactoryDevice = async () => {
    setError(null);

    try {
      const payload = await startFactoryDeviceOAuth();
      setDeviceAuth({ ...payload, provider: "factory" });
      setStatus(`Factory.ai device auth started. Enter code ${payload.userCode}; polling continues automatically.`);
    } catch (oauthError) {
      setError(oauthError instanceof Error ? oauthError.message : String(oauthError));
    }
  };

  const handleAddFactoryKey = () => {
    setApiKeyProvider("factory");
    setApiKeyAccount("");
    setApiKeyValue("");
  };

  const handleCopyField = useCallback(async (value: string, fieldKey: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedFieldKey(fieldKey);

      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedFieldKey((current) => (current === fieldKey ? null : current));
        copyResetTimerRef.current = null;
      }, 1200);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }, []);

  const handleRemoveAccount = useCallback(async (providerId: string, accountId: string, displayName: string) => {
    if (!window.confirm(`Remove credential "${displayName}" (${providerId}/${accountId})?`)) {
      return;
    }

    setError(null);

    try {
      await removeCredential(providerId, accountId);
      setStatus(`Removed credential ${displayName}.`);
      await refreshCredentials();
      await refreshQuota();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }, [refreshCredentials, refreshQuota]);

  const handleProbeAccount = useCallback(async (providerId: string, accountId: string) => {
    const stateKey = `${providerId}:${accountId}`;
    setError(null);
    setAccountProbeLoading((current) => ({ ...current, [stateKey]: true }));

    try {
      const result = await probeOpenAiCredentialAccount(accountId);
      setAccountProbeResults((current) => ({ ...current, [stateKey]: result }));
      await refreshQuota();
      await refreshPromptCacheAudit();
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      setAccountProbeResults((current) => ({
        ...current,
        [stateKey]: {
          providerId,
          accountId,
          displayName: `${providerId}/${accountId}`,
          testedAt: new Date().toISOString(),
          model: "gpt-5.2",
          expectedText: "hello",
          status: "error",
          ok: false,
          matchesExpectedOutput: false,
          message,
        },
      }));
    } finally {
      setAccountProbeLoading((current) => ({ ...current, [stateKey]: false }));
    }
  }, [refreshPromptCacheAudit, refreshQuota]);

  const renderQuotaRow = (label: string, window: CredentialQuotaWindow | null) => {
    const remainingPercent = window?.remainingPercent ?? null;
    const width = remainingPercent === null ? 0 : Math.min(100, Math.max(0, remainingPercent));
    const percentLabel = remainingPercent === null ? "No data" : `${Math.round(remainingPercent)}% left`;
    const resetLabel = formatResetSummary(window);

    return (
      <div key={label} className="credentials-quota-row">
        <div className="credentials-quota-row-header">
          <span>{label}</span>
          <strong>{percentLabel}</strong>
        </div>
        <div className="credentials-quota-bar">
          <span
            className={`credentials-quota-fill ${quotaToneClass(remainingPercent)}`}
            style={{ width: `${width}%` }}
          />
        </div>
        {resetLabel && <small>{resetLabel}</small>}
      </div>
    );
  };

  const renderQuotaGroup = (
    title: string,
    rateLimit: CredentialQuotaRateLimit | null,
    fallbackPrimary?: CredentialQuotaWindow | null,
    fallbackSecondary?: CredentialQuotaWindow | null,
  ) => {
    const primaryWindow = rateLimit?.primaryWindow ?? fallbackPrimary ?? null;
    const secondaryWindow = rateLimit?.secondaryWindow ?? fallbackSecondary ?? null;

    if (!rateLimit && !primaryWindow && !secondaryWindow) {
      return null;
    }

    return (
      <section key={title} className="credentials-quota-group">
        <div className="credentials-quota-group-header">
          <strong>{title}</strong>
          <span className={`credentials-badge ${quotaRateLimitBadgeClass(rateLimit)}`}>
            {formatQuotaRateLimitStatus(rateLimit)}
          </span>
        </div>
        <div className="credentials-quota-list">
          {primaryWindow && renderQuotaRow(formatQuotaWindowLabel(primaryWindow, "Primary window"), primaryWindow)}
          {secondaryWindow && renderQuotaRow(formatQuotaWindowLabel(secondaryWindow, "Secondary window"), secondaryWindow)}
          {!primaryWindow && !secondaryWindow && (
            <p className="credentials-quota-note">No window data returned for this rate-limit bucket.</p>
          )}
        </div>
      </section>
    );
  };

  const renderAccountTile = (entry: AccountEntry, showProviderBadge: boolean) => {
    const { account, providerId } = entry;
    const accountKey = `${providerId}:${account.id}`;
    const quota = quotaByAccount.get(accountKey);
    const diagnostics = accountDiagnostics.byAccount.get(accountKey);
    const planLabel = titleCasePlan(quota?.planType ?? account.planType);
    const expiryLabel = formatExpiryBadge(account.expiresAt);
    const visibleToken = revealSecrets ? account.secret : account.secretPreview;
    const visibleRefresh = revealSecrets ? account.refreshToken : account.refreshTokenPreview;
    const workspaceCopyKey = `${providerId}:${account.id}:workspace`;
    const internalCopyKey = `${providerId}:${account.id}:internal`;
    const shouldShowQuota = (providerId === "openai" && account.authType === "oauth_bearer") || Boolean(quota);
    const probeResult = accountProbeResults[accountKey];
    const probeLoading = accountProbeLoading[accountKey] === true;
    const duplicateCount = diagnostics?.duplicateCount ?? 0;
    const needsReauth = diagnostics?.needsReauth ?? false;
    const canReauth = providerId === "openai" && account.authType === "oauth_bearer";
    const canProbeAccount = providerId === "openai" && account.authType === "oauth_bearer";

    return (
      <article key={`${providerId}:${account.id}`} className="credentials-account-tile">
        <header className="credentials-account-header">
          <div className="credentials-account-title-wrap">
            <strong>{account.displayName}</strong>
            {account.email && account.email !== account.displayName && (
              <span className="credentials-account-subtitle">{account.email}</span>
            )}
          </div>
          <div className="credentials-provider-badges">
            {showProviderBadge && <span className="credentials-badge credentials-badge-muted">{providerId}</span>}
            {needsReauth && <span className="credentials-badge credentials-badge-danger">Reauth required</span>}
            {duplicateCount > 1 && <span className="credentials-badge credentials-badge-warning">Possible duplicate ×{duplicateCount}</span>}
            {planLabel && <span className="credentials-badge credentials-badge-accent">{planLabel}</span>}
            <span className="credentials-badge credentials-badge-muted">{formatAuthType(account.authType)}</span>
          </div>
        </header>

        <div className="credentials-account-chip-row">
          {account.chatgptAccountId && (
            <span className="credentials-chip">workspace {compactMiddle(account.chatgptAccountId)}</span>
          )}
          {expiryLabel && <span className="credentials-chip">expires {expiryLabel}</span>}
          <span className="credentials-chip">token {account.secretPreview}</span>
        </div>

        {(canReauth || canProbeAccount) && (
          <div className="credentials-account-actions">
            {canReauth && (
              <button
                type="button"
                className="credentials-shortcut-button"
                onClick={() => void startBrowserOAuth(entry)}
              >
                {needsReauth ? "Reauth now" : "Reauth"}
              </button>
            )}
            {canProbeAccount && (
              <button
                type="button"
                className="credentials-shortcut-button"
                onClick={() => void handleProbeAccount(providerId, account.id)}
                disabled={probeLoading}
              >
                {probeLoading ? "Testing…" : "Test live"}
              </button>
            )}
            {probeResult && (
              <span className={`credentials-badge ${probeBadgeClass(probeResult)}`}>
                {probeResult.ok ? "Live" : "Not live"}
              </span>
            )}
          </div>
        )}

        {probeResult && (
          <p className={`credentials-probe-note ${probeResult.ok ? "" : "credentials-probe-note-error"}`.trim()}>
            {probeResult.message} Tested {formatQuotaTimestamp(probeResult.testedAt)}.
          </p>
        )}

        {shouldShowQuota && (
          <section className="credentials-quota-card">
            <header className="credentials-quota-card-header">
              <strong>Codex quota</strong>
              <span>{quota ? `Updated ${formatQuotaTimestamp(quota.fetchedAt)}` : quotaLoading ? "Refreshing…" : "Not loaded"}</span>
            </header>
            {quota?.status === "ok" ? (
              <div className="credentials-quota-list">
                {renderQuotaGroup("General rate limit", quota.rateLimit, quota.fiveHour, quota.weekly)}
                {renderQuotaGroup("Code review rate limit", quota.codeReviewRateLimit)}
              </div>
            ) : quota?.status === "error" ? (
              <p className="credentials-quota-note credentials-quota-note-error">{quota.error ?? "Quota unavailable"}</p>
            ) : (
              <p className="credentials-quota-note">
                {quotaLoading ? "Loading current Codex quota…" : "Refresh Codex quotas to load live 5h and weekly usage."}
              </p>
            )}
          </section>
        )}

        <details className="credentials-account-details">
          <summary>Details</summary>
          <dl className="credentials-account-detail-list">
            <div className="credentials-account-detail-item credentials-account-detail-item-copyable">
              <div>
                <dt>Internal ID</dt>
                <dd>{account.id}</dd>
              </div>
              <button type="button" onClick={() => void handleCopyField(account.id, internalCopyKey)}>
                {copiedFieldKey === internalCopyKey ? "Copied" : "Copy"}
              </button>
            </div>
            {account.chatgptAccountId && (
              <div className="credentials-account-detail-item credentials-account-detail-item-copyable">
                <div>
                  <dt>Workspace</dt>
                  <dd>{account.chatgptAccountId}</dd>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyField(account.chatgptAccountId ?? "", workspaceCopyKey)}
                >
                  {copiedFieldKey === workspaceCopyKey ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            <div className="credentials-account-detail-item">
              <dt>Provider</dt>
              <dd>{providerId}</dd>
            </div>
            {quota && (
              <div className="credentials-account-detail-item">
                <dt>Quota refreshed</dt>
                <dd>{formatQuotaTimestamp(quota.fetchedAt)}</dd>
              </div>
            )}
            {account.email && (
              <div className="credentials-account-detail-item">
                <dt>Email</dt>
                <dd>{account.email}</dd>
              </div>
            )}
            {account.subject && (
              <div className="credentials-account-detail-item">
                <dt>Subject</dt>
                <dd>{account.subject}</dd>
              </div>
            )}
            <div className="credentials-account-detail-item">
              <dt>Access token</dt>
              <dd>{visibleToken}</dd>
            </div>
            {visibleRefresh && (
              <div className="credentials-account-detail-item">
                <dt>Refresh token</dt>
                <dd>{visibleRefresh}</dd>
              </div>
            )}
            {typeof account.expiresAt === "number" && (
              <div className="credentials-account-detail-item">
                <dt>Expires</dt>
                <dd>{new Date(account.expiresAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="credentials-remove-button"
            onClick={() => void handleRemoveAccount(providerId, account.id, account.displayName)}
          >
            Remove credential
          </button>
        </details>
      </article>
    );
  };

  return (
    <div className="credentials-layout">
      <section className="credentials-panel">
        <header>
          <h2>Credentials Manager</h2>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={revealSecrets}
              onChange={(event) => setRevealSecrets(event.currentTarget.checked)}
            />
            Reveal secrets
          </label>
        </header>

        <div className="credentials-toolbar">
          <input
            value={accountSearch}
            onChange={(event) => setAccountSearch(event.currentTarget.value)}
            placeholder="Search accounts, emails, plans, workspace IDs"
          />
          <label className="credentials-inline-control">
            <span>Group by</span>
            <select
              value={accountGrouping}
              onChange={(event) => setAccountGrouping(event.currentTarget.value as AccountGrouping)}
            >
              <option value="provider">Provider</option>
              <option value="plan">Plan</option>
              <option value="domain">Email domain</option>
            </select>
          </label>
          <button type="button" onClick={() => void Promise.all([refreshQuota(), refreshPromptCacheAudit()])} disabled={quotaLoading}>
            {quotaLoading ? "Refreshing Codex quotas..." : "Refresh Codex quotas"}
          </button>
          <button
            type="button"
            onClick={() => setShowReauthOnly((current) => !current)}
            disabled={!showReauthOnly && accountDiagnostics.reauthRequiredCount === 0}
          >
            {showReauthOnly ? "Show all accounts" : `Show reauth required (${accountDiagnostics.reauthRequiredCount})`}
          </button>
        </div>

        <div className="credentials-toolbar-meta-stack">
          <p className="credentials-toolbar-meta">
            Showing {filteredAccounts.length} of {flatAccounts.length} account(s)
          </p>
          <p className="credentials-toolbar-meta">
            {quotaOverview ? `Codex quotas updated ${formatQuotaTimestamp(quotaOverview.generatedAt)}` : "Codex quotas not loaded yet"}
          </p>
          <p className="credentials-toolbar-meta">
            {accountDiagnostics.reauthRequiredCount === 0
              ? "No accounts currently require reauth"
              : `${accountDiagnostics.reauthRequiredCount} account(s) currently require reauth`}
            {" · "}
            OpenAI identities {accountDiagnostics.humanIdentifiedOpenAiOauthCount}/{accountDiagnostics.openAiOauthCount}
            {" · "}
            {duplicateSummary}
          </p>
        </div>

        {quotaError && <p className="error-text">{quotaError}</p>}

        {openAiQuotaPool && (
          <article className="credentials-card credentials-pool-card">
            <header className="credentials-provider-header">
              <div>
                <h3>OpenAI OAuth quota pool</h3>
                <p>
                  {openAiQuotaPool.okAccounts}/{openAiQuotaPool.totalAccounts} live account(s)
                  {" · "}
                  {openAiQuotaPool.generalAvailableCount} available now
                  {" · "}
                  {openAiQuotaPool.errorAccounts} needing attention
                </p>
              </div>
              <div className="credentials-provider-badges">
                <span className={`credentials-badge ${quotaBadgeClassFromPercent(openAiQuotaPool.generalCombinedRemainingPercent)}`}>
                  {formatAggregatePercent(openAiQuotaPool.generalCombinedRemainingPercent)} combined left
                </span>
              </div>
            </header>

            <div className="credentials-quota-bar credentials-pool-bar">
              <span
                className={`credentials-quota-fill ${quotaToneClass(openAiQuotaPool.generalCombinedRemainingPercent)}`}
                style={{ width: `${Math.max(0, Math.min(100, openAiQuotaPool.generalCombinedRemainingPercent ?? 0))}%` }}
              />
            </div>

            <div className="credentials-pool-grid">
              <dl className="credentials-pool-metric">
                <dt>Combined general quota left</dt>
                <dd>{formatAggregatePercent(openAiQuotaPool.generalCombinedRemainingPercent)}</dd>
                <small>{openAiQuotaPool.windowLabel}</small>
              </dl>
              <dl className="credentials-pool-metric">
                <dt>Combined code review left</dt>
                <dd>{formatAggregatePercent(openAiQuotaPool.codeReviewCombinedRemainingPercent)}</dd>
                <small>{openAiQuotaPool.codeReviewWindowLabel}</small>
              </dl>
              <dl className="credentials-pool-metric">
                <dt>Available now</dt>
                <dd>{openAiQuotaPool.generalAvailableCount}/{openAiQuotaPool.okAccounts}</dd>
                <small>{openAiQuotaPool.generalBlockedCount} blocked · {openAiQuotaPool.codeReviewAvailableCount} code review-ready</small>
              </dl>
              <dl className="credentials-pool-metric">
                <dt>Next general reset</dt>
                <dd>{openAiQuotaPool.nextResetWindow ? (formatResetSummary(openAiQuotaPool.nextResetWindow) ?? "Unknown") : "Unknown"}</dd>
                <small>{openAiQuotaPool.nextResetWindow ? formatQuotaWindowLabel(openAiQuotaPool.nextResetWindow, "Primary window") : "No reset window data"}</small>
              </dl>
            </div>

            <p className="credentials-pool-meta">
              Combined pool is computed from live remaining percentages across OpenAI OAuth accounts with quota data.
            </p>
          </article>
        )}

        {promptCacheAudit && (
          <article className="credentials-card credentials-pool-card">
            <header className="credentials-provider-header">
              <div>
                <h3>Prompt cache affinity audit</h3>
                <p>
                  {promptCacheAudit.crossSuccessfulAccountHashCount} multi-success-account hash(es)
                  {" · "}
                  {promptCacheAudit.crossAccountHashCount} cross-account hash(es)
                  {" · "}
                  {promptCacheAudit.distinctHashCount} distinct hash(es)
                  {" · "}
                  scanned {promptCacheAudit.scannedEntryCount} recent OpenAI OAuth request(s)
                </p>
              </div>
            </header>

            {promptCacheAudit.rows.length > 0 ? (
              <div className="credentials-audit-table">
                <div className="credentials-audit-header">
                  <span>Hash</span>
                  <span>Successful accounts</span>
                  <span>Failed retries</span>
                  <span>Requests</span>
                  <span>Cache</span>
                  <span>Last seen</span>
                </div>
                {promptCacheAudit.rows.map((row) => {
                  const cacheRate = row.promptTokens > 0 ? (row.cachedPromptTokens / row.promptTokens) * 100 : null;
                  return (
                    <div key={row.promptCacheKeyHash} className="credentials-audit-row">
                      <div>
                        <strong>{row.promptCacheKeyHash}</strong>
                        {row.latestModel && <small>{row.providerId} · {row.latestModel}</small>}
                      </div>
                      <div>
                        <span className={`credentials-badge ${row.successfulAccountCount > 1 ? "credentials-badge-warning" : "credentials-badge-accent"}`}>
                          {row.successfulAccountCount} successful account{row.successfulAccountCount === 1 ? "" : "s"}
                        </span>
                        <small>{row.successfulAccountIds.join(", ") || "None"}</small>
                      </div>
                      <div>
                        <span className={`credentials-badge ${row.failedAccountCount > 0 ? "credentials-badge-danger" : "credentials-badge-muted"}`}>
                          {row.failedAccountCount} failed account{row.failedAccountCount === 1 ? "" : "s"}
                        </span>
                        <small>{row.failedAccountIds.join(", ") || "None"}</small>
                      </div>
                      <div>
                        <strong>{row.requestCount}</strong>
                        <small>{row.successfulRequestCount} success · {row.failedRequestCount} failed · {row.cacheHitCount} hit{row.cacheHitCount === 1 ? "" : "s"} · {row.shapeFingerprintCount} shape{row.shapeFingerprintCount === 1 ? "" : "s"}</small>
                      </div>
                      <div>
                        <strong>{formatAggregatePercent(cacheRate)}</strong>
                        <small>{row.cachedPromptTokens.toLocaleString()} / {row.promptTokens.toLocaleString()} prompt tokens</small>
                      </div>
                      <div>
                        <strong>{row.lastSeenAt ? formatQuotaTimestamp(row.lastSeenAt) : "Never"}</strong>
                        <small>{row.firstSeenAt ? `first ${formatQuotaTimestamp(row.firstSeenAt)}` : ""}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="credentials-pool-meta">No prompt-cache hashes have been recorded in recent OpenAI OAuth request logs yet.</p>
            )}
          </article>
        )}

        {promptCacheAudit && (
          <article className="credentials-card credentials-pool-card">
            <header className="credentials-provider-header">
              <div>
                <h3>Cache stability watchlist</h3>
                <p>
                  Single-success-account hashes with one stable request shape and enough traffic to judge cache reliability.
                </p>
              </div>
            </header>

            {cacheStabilityWatchRows.length > 0 ? (
              <div className="credentials-watch-grid">
                {cacheStabilityWatchRows.map((row) => (
                  <article key={`watch-${row.promptCacheKeyHash}`} className="credentials-pool-metric credentials-watch-card">
                    <div>
                      <strong>{row.promptCacheKeyHash}</strong>
                      <small>{row.providerId} · {row.latestModel ?? "unknown model"}</small>
                    </div>
                    <div className="credentials-provider-badges">
                      <span className={`credentials-badge ${quotaBadgeClassFromPercent(row.cacheRate)}`}>
                        {formatAggregatePercent(row.cacheRate)} cache
                      </span>
                      <span className="credentials-badge credentials-badge-muted">
                        {row.successfulRequestCount} success
                      </span>
                    </div>
                    <dl className="credentials-watch-metrics">
                      <div>
                        <dt>Successful account</dt>
                        <dd>{row.successfulAccountIds[0] ?? "Unknown"}</dd>
                      </div>
                      <div>
                        <dt>Prompt tokens</dt>
                        <dd>{row.promptTokens.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Cached prompt tokens</dt>
                        <dd>{row.cachedPromptTokens.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Shape fingerprints</dt>
                        <dd>{row.shapeFingerprints.join(", ")}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <p className="credentials-pool-meta">No stable same-account hashes currently look anomalous enough to flag.</p>
            )}
          </article>
        )}

        {groupedAccountSections.length > 0 ? (
          <div className="credentials-provider-stack">
            {groupedAccountSections.map((section) => (
              <article key={section.key} className="credentials-card credentials-provider-card">
                <header className="credentials-provider-header">
                  <div>
                    <h3>{section.title}</h3>
                    <p>{section.description}</p>
                  </div>
                  <div className="credentials-provider-badges">
                    <span className="credentials-badge credentials-badge-muted">{section.badge}</span>
                    <span className="credentials-badge">{section.badgeMuted}</span>
                  </div>
                </header>

                <div className="credentials-account-grid">
                  {section.accounts.map((entry) => renderAccountTile(entry, accountGrouping !== "provider"))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <article className="credentials-card">
            <p>No credential accounts match the current filter.</p>
          </article>
        )}

        <div className="credentials-provider-grid">
          {providerHealth.map((provider) => (
            <article key={`health-${provider.providerId}`} className="credentials-card">
              <h3>{provider.providerId}</h3>
              <p>Recent logs: {provider.logs?.count ?? 0}</p>
              {provider.logs && <p>Last request: {new Date(provider.logs.lastTimestamp).toLocaleString()}</p>}
              {provider.keyPool ? (
                <>
                  <p>Accounts ready: {provider.keyPool.availableAccounts}/{provider.keyPool.totalAccounts}</p>
                  <p>Cooldown accounts: {provider.keyPool.cooldownAccounts}</p>
                </>
              ) : (
                <p>No key pool status yet.</p>
              )}
            </article>
          ))}
        </div>

        <form className="credentials-form" onSubmit={(event) => void handleApiKeySubmit(event)}>
          <h3>Add API key account</h3>
          <div className="credentials-form-shortcuts">
            <button type="button" onClick={handleAddFactoryKey} className="credentials-shortcut-button">
              Add Factory Key
            </button>
          </div>
          <select
            value={apiKeyProvider}
            onChange={(event) => setApiKeyProvider(event.currentTarget.value)}
          >
            <option value="vivgrid">Vivgrid</option>
            <option value="openai">OpenAI</option>
            <option value="ollama-cloud">Ollama Cloud</option>
            <option value="ollama">Ollama (local)</option>
            <option value="ollama-stealth">Ollama Stealth</option>
            <option value="ollama-big-ussy">Ollama Big Ussy</option>
            <option value="requesty">Requesty</option>
            <option value="zen">Zen/ZenMux</option>
            <option value="openrouter">OpenRouter</option>
            <option value="gemini">Gemini</option>
            <option value="zai">Z.ai (GLM)</option>
            <option value="mistral">Mistral</option>
            <option value="factory">Factory</option>
            <option value="ob1">OB1</option>
          </select>
          <input
            value={apiKeyAccount}
            onChange={(event) => setApiKeyAccount(event.currentTarget.value)}
            placeholder="account id (optional — auto-generated if empty)"
          />
          <input
            type="password"
            value={apiKeyValue}
            onChange={(event) => setApiKeyValue(event.currentTarget.value)}
            placeholder="api key"
          />
          <button type="submit">Save API key</button>
        </form>

        <div className="credentials-oauth">
          <h3>OpenAI OAuth</h3>
          <div className="credentials-oauth-row">
            <button type="button" onClick={() => void startBrowserOAuth()}>
              Start browser flow
            </button>
            <button type="button" onClick={() => void startDeviceOAuth()}>
              Start device flow
            </button>
            <button type="button" onClick={() => void pollDeviceOAuth()} disabled={!deviceAuth || deviceAuth.provider !== "openai"}>
              {devicePolling && deviceAuth?.provider === "openai" ? "Polling..." : "Poll device flow"}
            </button>
          </div>

          {deviceAuth && deviceAuth.provider === "openai" && (
            <p>
              Visit{" "}
              <a href={deviceAuth.verificationUrl} target="_blank" rel="noreferrer">
                {deviceAuth.verificationUrl}
              </a>{" "}
              and enter code <strong>{deviceAuth.userCode}</strong>.
            </p>
          )}
        </div>

        <div className="credentials-oauth">
          <h3>Factory.ai OAuth</h3>
          <div className="credentials-oauth-row">
            <button type="button" onClick={() => void startFactoryBrowser()}>
              Start browser flow
            </button>
            <button type="button" onClick={() => void startFactoryDevice()}>
              Start device flow
            </button>
            <button type="button" onClick={() => void pollDeviceOAuth()} disabled={!deviceAuth || deviceAuth.provider !== "factory"}>
              {devicePolling && deviceAuth?.provider === "factory" ? "Polling..." : "Poll device flow"}
            </button>
          </div>

          {deviceAuth && deviceAuth.provider === "factory" && (
            <p>
              Visit{" "}
              <a href={deviceAuth.verificationUrl} target="_blank" rel="noreferrer">
                {deviceAuth.verificationUrl}
              </a>{" "}
              and enter code <strong>{deviceAuth.userCode}</strong>.
            </p>
          )}
        </div>

        {status && <p className="status-text">{status}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="credentials-panel">
        <header>
          <h2>Request Logs</h2>
        </header>

        <div className="credentials-log-filters">
          <input
            value={selectedProvider}
            onChange={(event) => setSelectedProvider(event.currentTarget.value)}
            placeholder="filter provider"
          />
          <input
            list="account-ids"
            value={selectedAccount}
            onChange={(event) => setSelectedAccount(event.currentTarget.value)}
            placeholder="filter account"
          />
          <datalist id="account-ids">
            {allAccountIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <button type="button" onClick={() => void refreshLogs()}>
            Refresh logs
          </button>
        </div>

        <div className="credentials-log-table">
          {logs.map((entry) => {
            const origin = formatRequestOrigin(entry);
            const originPart = origin !== "unknown" && origin !== "local" ? ` · from ${origin}` : "";
            return (
              <article key={entry.id}>
                <header>
                  <strong>{entry.providerId}/{entry.accountId}</strong>
                  <span>{entry.status} · {entry.latencyMs}ms</span>
                </header>
                <p>
                  {entry.model} · {entry.upstreamMode} · {formatServiceTier(entry)} · {formatRouteLabel(entry)}
                  {originPart}
                  {" · "}{new Date(entry.timestamp).toLocaleString()}
                  {typeof entry.totalTokens === "number" ? ` · ${entry.totalTokens} tok` : ""}
                </p>
                {entry.error && <small>{entry.error}</small>}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
