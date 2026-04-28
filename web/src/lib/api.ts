export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
  readonly forkedFromSessionId?: string;
  readonly forkedFromMessageId?: string;
}

export interface SessionMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly reasoningContent?: string;
  readonly model?: string;
  readonly createdAt: number;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly promptCacheKey: string;
  readonly forkedFromSessionId?: string;
  readonly forkedFromMessageId?: string;
  readonly messages: SessionMessage[];
}

export interface CredentialAccount {
  readonly id: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly displayName: string;
  readonly secretPreview: string;
  readonly secret?: string;
  readonly refreshTokenPreview?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

export interface CredentialProvider {
  readonly id: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly accountCount: number;
  readonly accounts: CredentialAccount[];
}

export interface RequestLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly keyId?: string;
  readonly routeKind: "local" | "federated" | "bridge";
  readonly federationOwnerSubject?: string;
  readonly routedPeerId?: string;
  readonly routedPeerLabel?: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: "api_key" | "oauth_bearer" | "local" | "none";
  readonly model: string;
  readonly upstreamMode: string;
  readonly upstreamPath: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly serviceTier?: string;
  readonly serviceTierSource: "fast_mode" | "explicit" | "none";
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyHash?: string;
  readonly ttftMs?: number;
  readonly decodeTps?: number;
  readonly tps?: number;
  readonly endToEndTps?: number;
  readonly error?: string;
}

export interface PromptCacheAuditRow {
  readonly promptCacheKeyHash: string;
  readonly providerId: string;
  readonly requestCount: number;
  readonly accountCount: number;
  readonly accountIds: readonly string[];
  readonly successfulRequestCount: number;
  readonly failedRequestCount: number;
  readonly successfulAccountCount: number;
  readonly successfulAccountIds: readonly string[];
  readonly failedAccountCount: number;
  readonly failedAccountIds: readonly string[];
  readonly shapeFingerprintCount: number;
  readonly shapeFingerprints: readonly string[];
  readonly cacheHitCount: number;
  readonly cachedPromptTokens: number;
  readonly promptTokens: number;
  readonly latestModel?: string;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface PromptCacheAuditOverview {
  readonly generatedAt: string;
  readonly scannedEntryCount: number;
  readonly distinctHashCount: number;
  readonly crossAccountHashCount: number;
  readonly crossSuccessfulAccountHashCount: number;
  readonly rows: readonly PromptCacheAuditRow[];
  readonly watchRows: readonly PromptCacheAuditRow[];
}

export interface KeyPoolStatus {
  readonly providerId: string;
  readonly authType: "api_key" | "oauth_bearer" | "unknown";
  readonly totalAccounts: number;
  readonly availableAccounts: number;
  readonly cooldownAccounts: number;
  readonly nextReadyInMs: number;
}

export interface ProviderRequestLogSummary {
  readonly count: number;
  readonly lastTimestamp: number;
}

export interface ToolSeed {
  readonly id: string;
  readonly description: string;
  readonly enabled: boolean;
}

export interface McpServerSeed {
  readonly id: string;
  readonly script: string;
  readonly cwd?: string;
  readonly args: readonly string[];
  readonly port?: number;
  readonly sourceFile: string;
  readonly running: false;
}

export interface SearchResult {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly createdAt: number;
  readonly distance: number;
}

export interface UsageTrendPoint {
  readonly t: string;
  readonly v: number;
}

export interface ProxyUiSettings {
  readonly fastMode: boolean;
  readonly requestsPerMinute?: number | null;
  readonly allowedProviderIds?: readonly string[] | null;
  readonly disabledProviderIds?: readonly string[] | null;
  readonly tenantId?: string;
}

export interface HostDashboardContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: readonly string[];
}

export interface HostDashboardRouteSummary {
  readonly host: string;
  readonly matcher?: string;
  readonly matchPaths: readonly string[];
  readonly upstreams: readonly string[];
}

export interface HostDashboardSummary {
  readonly containerCount: number;
  readonly runningCount: number;
  readonly healthyCount: number;
  readonly routeCount: number;
}

export interface HostDashboardSnapshot {
  readonly id: string;
  readonly label: string;
  readonly source: "local" | "remote";
  readonly fetchedAt: string;
  readonly reachable: boolean;
  readonly baseUrl?: string;
  readonly publicHost?: string;
  readonly notes?: string;
  readonly errors: readonly string[];
  readonly containers: readonly HostDashboardContainerSummary[];
  readonly routes: readonly HostDashboardRouteSummary[];
  readonly summary: HostDashboardSummary;
}

export interface HostsOverview {
  readonly generatedAt: string;
  readonly selfTargetId: string | null;
  readonly hosts: readonly HostDashboardSnapshot[];
}

export interface UsageAccountSummary {
  readonly accountId: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly authType: "api_key" | "oauth_bearer" | "local" | "none";
  readonly planType?: string;
  readonly status: "healthy" | "cooldown" | "idle";
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly avgTtftMs: number | null;
  readonly avgDecodeTps: number | null;
  readonly avgTps: number | null;
  readonly avgEndToEndTps: number | null;
  readonly healthScore: number | null;
  readonly transientDebuff: number | null;
  readonly lastUsedAt: string | null;
}

export interface UsageOverview {
  readonly window?: "daily" | "weekly" | "monthly";
  readonly generatedAt: string;
  readonly coverage?: {
    readonly requestedWindowStart: string;
    readonly coverageStart: string | null;
    readonly hasFullWindowCoverage: boolean;
    readonly retainedEntryCount: number;
    readonly maxRetainedEntries: number;
  };
  readonly summary: {
    readonly requests24h: number;
    readonly tokens24h: number;
    readonly promptTokens24h: number;
    readonly completionTokens24h: number;
    readonly cachedPromptTokens24h: number;
    readonly imageCount24h: number;
    readonly imageCostUsd24h: number;
    readonly costUsd24h: number;
    readonly energyJoules24h: number;
    readonly waterEvaporatedMl24h: number;
    readonly cacheKeyUses24h: number;
    readonly cacheHitRate24h: number;
    readonly errorRate24h: number;
    readonly topModel: string | null;
    readonly topProvider: string | null;
    readonly activeAccounts: number;
    readonly routingRequests24h: {
      readonly local: number;
      readonly federated: number;
      readonly bridge: number;
      readonly distinctPeers: number;
      readonly topPeer: string | null;
    };
    readonly serviceTierRequests24h: {
      readonly fastMode: number;
      readonly priority: number;
      readonly standard: number;
    };
  };
  readonly trends: {
    readonly requests: readonly UsageTrendPoint[];
    readonly tokens: readonly UsageTrendPoint[];
    readonly errors: readonly UsageTrendPoint[];
  };
  readonly accounts: readonly UsageAccountSummary[];
}

export interface AnalyticsCoverage {
  readonly requestedWindowStart: string;
  readonly coverageStart: string | null;
  readonly hasFullWindowCoverage: boolean;
  readonly retainedEntryCount: number;
  readonly maxRetainedEntries: number;
}

export interface AnalyticsRow {
  readonly providerId?: string;
  readonly model?: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly errorRate: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheHitRate: number;
  readonly avgTtftMs: number | null;
  readonly avgDecodeTps: number | null;
  readonly avgTps: number | null;
  readonly avgEndToEndTps: number | null;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly providerCoverageCount?: number;
  readonly modelCoverageCount?: number;
  readonly confidenceScore: number;
  readonly suitabilityScore: number | null;
}

export interface ProviderModelAnalytics {
  readonly window: "daily" | "weekly" | "monthly";
  readonly generatedAt: string;
  readonly coverage: AnalyticsCoverage;
  readonly models: readonly AnalyticsRow[];
  readonly providers: readonly AnalyticsRow[];
  readonly providerModels: readonly AnalyticsRow[];
}

export interface CredentialQuotaWindow {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly resetAfterSeconds: number | null;
  readonly limitWindowSeconds: number | null;
}

export interface CredentialQuotaRateLimit {
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  readonly primaryWindow: CredentialQuotaWindow | null;
  readonly secondaryWindow: CredentialQuotaWindow | null;
}

export interface CredentialQuotaAccountSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly status: "ok" | "error";
  readonly fetchedAt: string;
  readonly fiveHour: CredentialQuotaWindow | null;
  readonly weekly: CredentialQuotaWindow | null;
  readonly rateLimit: CredentialQuotaRateLimit | null;
  readonly codeReviewRateLimit: CredentialQuotaRateLimit | null;
  readonly error?: string;
}

export interface CredentialQuotaOverview {
  readonly generatedAt: string;
  readonly accounts: readonly CredentialQuotaAccountSummary[];
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

export interface FederationPeer {
  readonly id: string;
  readonly ownerSubject: string;
  readonly peerDid?: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly controlBaseUrl?: string;
  readonly authMode: "admin_key" | "at_did";
  readonly auth: Record<string, unknown>;
  readonly status: string;
  readonly capabilities: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FederationSelf {
  readonly nodeId: string | null;
  readonly groupId: string | null;
  readonly clusterId: string | null;
  readonly peerDid: string | null;
  readonly publicBaseUrl: string | null;
  readonly peerCount: number;
}

export interface FederationProjectedAccount {
  readonly sourcePeerId: string;
  readonly ownerSubject: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly accountSubject?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly planType?: string;
  readonly availabilityState: string;
  readonly warmRequestCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FederationKnownAccount {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly authType: "api_key" | "oauth_bearer" | "local" | "none";
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly ownerSubject?: string | null;
  readonly projectedState?: string;
  readonly warmRequestCount?: number;
  readonly hasCredentials: boolean;
  readonly knowledgeSources: readonly string[];
}

export interface FederationAccountsOverview {
  readonly ownerSubject: string | null;
  readonly localAccounts: readonly FederationKnownAccount[];
  readonly projectedAccounts: readonly FederationProjectedAccount[];
  readonly knownAccounts: readonly FederationKnownAccount[];
}

export interface FederationSyncResult {
  readonly peer: FederationPeer;
  readonly ownerSubject: string;
  readonly importedProjectedAccountsCount: number;
  readonly importedUsageCount: number;
  readonly remoteDiffCount: number;
  readonly syncState: {
    readonly peerId: string;
    readonly lastPulledSeq: number;
    readonly lastPushedSeq: number;
    readonly lastPullAt?: string;
    readonly lastPushAt?: string;
    readonly lastError?: string | null;
    readonly updatedAt: string;
  };
}

export interface FederationBridgeSessionSummary {
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly state?: string;
  readonly peerDid?: string;
  readonly agentId?: string;
  readonly clusterId?: string;
  readonly groupId?: string;
  readonly lastError?: { readonly message?: string };
}

const AUTH_TOKEN_KEY = "open-hax-proxy.auth-token";
const AUTH_TOKEN_COOKIE = "open_hax_proxy_auth_token";

function configuredApiBaseUrl(): string {
  const env = (import.meta as { readonly env?: Record<string, unknown> }).env;
  const explicit = typeof env?.VITE_API_BASE_URL === "string" ? env.VITE_API_BASE_URL.trim() : "";
  if (explicit.length > 0) {
    return explicit.replace(/\/+$/, "");
  }

  if (typeof window === "undefined") {
    return "";
  }

  const { protocol, hostname, port } = window.location;
  if (port === "5174") {
    return `${protocol}//${hostname}:8789`;
  }

  return "";
}

const API_BASE_URL = configuredApiBaseUrl();

function buildApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

function readCookie(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!match) {
    return "";
  }

  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return match.slice(prefix.length);
  }
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") {
    return;
  }

  if (value.length === 0) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
    return;
  }

  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${60 * 60 * 24 * 30}; Path=/; SameSite=Lax`;
}

function readStoredAuthToken(): string {
  const fromLocalStorage = typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY)?.trim() ?? "" : "";
  if (fromLocalStorage.length > 0) {
    return fromLocalStorage;
  }

  const fromCookie = readCookie(AUTH_TOKEN_COOKIE).trim();
  if (fromCookie.length > 0 && typeof localStorage !== "undefined") {
    localStorage.setItem(AUTH_TOKEN_KEY, fromCookie);
  }
  return fromCookie;
}

function authHeaders(): Headers {
  const headers = new Headers();
  const token = readStoredAuthToken();
  if (token && token.length > 0) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders();

  if (init.headers) {
    const incoming = new Headers(init.headers);
    for (const [key, value] of incoming.entries()) {
      headers.set(key, value);
    }
  }

  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers,
  });

  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = typeof parsed?.error?.message === "string"
      ? parsed.error.message
      : typeof parsed?.detail === "string"
        ? parsed.detail
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

export function getSavedAuthToken(): string {
  return readStoredAuthToken();
}

export function saveAuthToken(token: string): void {
  if (typeof localStorage !== "undefined") {
    if (token.length > 0) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  }
  writeCookie(AUTH_TOKEN_COOKIE, token);
}

export function getApiOrigin(): string {
  if (API_BASE_URL.length > 0) {
    return API_BASE_URL;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "";
}

export async function listSessions(): Promise<SessionListItem[]> {
  const payload = await requestJson<{ readonly sessions: SessionListItem[] }>("/api/v1/sessions");
  return payload.sessions;
}

export async function createSession(title?: string): Promise<SessionRecord> {
  const payload = await requestJson<{ readonly session: SessionRecord }>("/api/v1/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  return payload.session;
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  const payload = await requestJson<{ readonly session: SessionRecord }>(`/api/v1/sessions/${sessionId}`);
  return payload.session;
}

export async function getSessionPromptCacheKey(sessionId: string): Promise<string> {
  const payload = await requestJson<{ readonly promptCacheKey: string }>(`/api/v1/sessions/${sessionId}/cache-key`);
  return payload.promptCacheKey;
}

export async function addSessionMessage(
  sessionId: string,
  message: {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
    readonly reasoningContent?: string;
    readonly model?: string;
  },
): Promise<SessionMessage> {
  const payload = await requestJson<{ readonly message: SessionMessage }>(`/api/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });
  return payload.message;
}

export async function forkSession(sessionId: string, messageId?: string): Promise<SessionRecord> {
  const payload = await requestJson<{ readonly session: SessionRecord }>(`/api/v1/sessions/${sessionId}/fork`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ messageId }),
  });
  return payload.session;
}

export async function searchSessionHistory(query: string, limit: number): Promise<{ readonly source: string; readonly results: SearchResult[] }> {
  return requestJson<{ readonly source: string; readonly results: SearchResult[] }>("/api/v1/sessions/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, limit }),
  });
}

export async function runChatCompletion(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function runImageGeneration(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>("/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function listModels(): Promise<string[]> {
  const payload = await requestJson<{
    readonly data?: ReadonlyArray<{ readonly id?: string }>;
  }>("/v1/models");

  if (!Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
    .filter((modelId, index, all) => modelId.length > 0 && all.indexOf(modelId) === index)
    .sort((a, b) => a.localeCompare(b));
}

export async function getUsageOverview(sort?: string, window?: "daily" | "weekly" | "monthly"): Promise<UsageOverview> {
  const query = new URLSearchParams();
  if (typeof sort === "string" && sort.trim().length > 0) {
    query.set("sort", sort.trim());
  }
  if (typeof window === "string" && window.trim().length > 0) {
    query.set("window", window.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<UsageOverview>(`/api/v1/dashboard/overview${suffix}`);
}

export async function getHostsOverview(): Promise<HostsOverview> {
  return requestJson<HostsOverview>("/api/v1/hosts/overview");
}

export async function getProviderModelAnalytics(sort?: string, window?: "daily" | "weekly" | "monthly"): Promise<ProviderModelAnalytics> {
  const query = new URLSearchParams();
  if (typeof sort === "string" && sort.trim().length > 0) {
    query.set("sort", sort.trim());
  }
  if (typeof window === "string" && window.trim().length > 0) {
    query.set("window", window.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<ProviderModelAnalytics>(`/api/v1/analytics/provider-model${suffix}`);
}

export async function getProxyUiSettings(): Promise<ProxyUiSettings> {
  return requestJson<ProxyUiSettings>("/api/v1/settings");
}

export async function saveProxyUiSettings(settings: ProxyUiSettings): Promise<ProxyUiSettings> {
  return requestJson<ProxyUiSettings>("/api/v1/settings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(settings),
  });
}

export async function listCredentials(reveal: boolean): Promise<{
  readonly providers: CredentialProvider[];
  readonly keyPoolStatuses: Record<string, KeyPoolStatus>;
  readonly requestLogSummary: Record<string, ProviderRequestLogSummary>;
}> {
  const query = reveal ? "?reveal=1" : "";
  return requestJson(`/api/v1/credentials${query}`);
}

export async function addApiKeyCredential(providerId: string, apiKey: string, accountId?: string): Promise<void> {
  const payload: Record<string, unknown> = { providerId, apiKey };
  if (typeof accountId === "string" && accountId.trim().length > 0) {
    payload.accountId = accountId.trim();
  }

  await requestJson("/api/v1/credentials/api-key", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function removeCredential(providerId: string, accountId: string): Promise<void> {
  await requestJson("/api/v1/credentials/account", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ providerId, accountId }),
  });
}

export async function disableAccount(providerId: string, accountId: string): Promise<void> {
  await requestJson("/api/v1/credentials/account/disable", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ providerId, accountId }),
  });
}

export async function enableAccount(providerId: string, accountId: string): Promise<void> {
  await requestJson("/api/v1/credentials/account/enable", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ providerId, accountId }),
  });
}

export async function getDisabledAccounts(): Promise<{
  readonly disabledAccounts: Array<{ readonly providerId: string; readonly accountId: string }>;
}> {
  return requestJson("/api/v1/credentials/accounts/disabled");
}

export async function getOpenAiCredentialQuota(accountId?: string): Promise<CredentialQuotaOverview> {
  const query = new URLSearchParams();
  if (accountId && accountId.trim().length > 0) {
    query.set("accountId", accountId.trim());
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<CredentialQuotaOverview>(`/api/v1/credentials/openai/quota${suffix}`);
}

export async function getOpenAiPromptCacheAudit(limit?: number): Promise<PromptCacheAuditOverview> {
  const query = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    query.set("limit", String(Math.floor(limit)));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<PromptCacheAuditOverview>(`/api/v1/credentials/openai/prompt-cache-audit${suffix}`);
}

export async function probeOpenAiCredentialAccount(accountId: string): Promise<OpenAiAccountProbeResult> {
  return requestJson<OpenAiAccountProbeResult>("/api/v1/credentials/openai/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ accountId }),
  });
}

export async function startOpenAiBrowserOAuth(redirectBaseUrl: string, accountId?: string): Promise<{
  readonly authorizeUrl: string;
}> {
  return requestJson("/api/v1/credentials/openai/oauth/browser/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ redirectBaseUrl, accountId }),
  });
}

export async function startOpenAiDeviceOAuth(): Promise<{
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}> {
  return requestJson("/api/v1/credentials/openai/oauth/device/start", {
    method: "POST",
  });
}

export async function pollOpenAiDeviceOAuth(deviceAuthId: string, userCode: string): Promise<{
  readonly state: "pending" | "authorized" | "failed";
  readonly reason?: string;
}> {
  return requestJson("/api/v1/credentials/openai/oauth/device/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceAuthId, userCode }),
  });
}

// ─── Factory.ai OAuth API ─────────────────────────────────────────────────

export async function startFactoryBrowserOAuth(redirectBaseUrl: string): Promise<{
  readonly authorizeUrl: string;
  readonly state: string;
}> {
  return requestJson("/api/v1/credentials/factory/oauth/browser/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ redirectBaseUrl }),
  });
}

export async function startFactoryDeviceOAuth(): Promise<{
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}> {
  return requestJson("/api/v1/credentials/factory/oauth/device/start", {
    method: "POST",
  });
}

export async function pollFactoryDeviceOAuth(deviceAuthId: string): Promise<{
  readonly state: "pending" | "authorized" | "failed";
  readonly reason?: string;
}> {
  return requestJson("/api/v1/credentials/factory/oauth/device/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceAuthId }),
  });
}

export async function listRequestLogs(filters: {
  readonly providerId?: string;
  readonly accountId?: string;
  readonly limit?: number;
  readonly before?: string;
}): Promise<RequestLogEntry[]> {
  const query = new URLSearchParams();
  if (filters.providerId) {
    query.set("providerId", filters.providerId);
  }
  if (filters.accountId) {
    query.set("accountId", filters.accountId);
  }
  if (typeof filters.limit === "number") {
    query.set("limit", String(filters.limit));
  }
  if (filters.before) {
    query.set("before", filters.before);
  }

  const suffix = query.toString().length > 0 ? `?${query.toString()}` : "";
  const payload = await requestJson<{ readonly entries: RequestLogEntry[] }>(`/api/v1/request-logs${suffix}`);
  return payload.entries;
}

export async function listToolSeeds(model: string): Promise<ToolSeed[]> {
  const payload = await requestJson<{ readonly tools: ToolSeed[] }>(`/api/v1/tools?model=${encodeURIComponent(model)}`);
  return payload.tools;
}

export async function listMcpSeeds(): Promise<McpServerSeed[]> {
  const payload = await requestJson<{ readonly servers: McpServerSeed[] }>("/api/v1/mcp-servers");
  return payload.servers;
}

export async function getFederationSelf(): Promise<FederationSelf> {
  return requestJson<FederationSelf>("/api/v1/federation/self");
}

export async function listFederationPeers(ownerSubject?: string): Promise<readonly FederationPeer[]> {
  const suffix = ownerSubject && ownerSubject.trim().length > 0
    ? `?ownerSubject=${encodeURIComponent(ownerSubject.trim())}`
    : "";
  const payload = await requestJson<{ readonly peers: readonly FederationPeer[] }>(`/api/v1/federation/peers${suffix}`);
  return payload.peers;
}

export async function addFederationPeer(input: {
  readonly ownerCredential: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly peerDid?: string;
  readonly controlBaseUrl?: string;
  readonly auth?: Record<string, unknown>;
}): Promise<FederationPeer> {
  const payload = await requestJson<{ readonly peer: FederationPeer }>("/api/v1/federation/peers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return payload.peer;
}

export async function getFederationAccounts(ownerSubject?: string): Promise<FederationAccountsOverview> {
  const suffix = ownerSubject && ownerSubject.trim().length > 0
    ? `?ownerSubject=${encodeURIComponent(ownerSubject.trim())}`
    : "";
  return requestJson<FederationAccountsOverview>(`/api/v1/federation/accounts${suffix}`);
}

export async function syncFederationPeer(input: {
  readonly peerId: string;
  readonly ownerSubject?: string;
  readonly sinceMs?: number;
  readonly pullUsage?: boolean;
}): Promise<FederationSyncResult> {
  return requestJson<FederationSyncResult>("/api/v1/federation/sync/pull", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function listFederationBridges(): Promise<readonly FederationBridgeSessionSummary[]> {
  const payload = await requestJson<{ readonly sessions: readonly FederationBridgeSessionSummary[] }>("/api/v1/federation/bridges");
  return payload.sessions;
}
