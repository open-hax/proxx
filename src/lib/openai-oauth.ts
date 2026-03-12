import { createHash } from "node:crypto";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_BROWSER_CALLBACK_PORT = "1455";

interface PkceCodes {
  readonly verifier: string;
  readonly challenge: string;
}

interface BrowserPendingState {
  readonly createdAt: number;
  readonly redirectUri: string;
  readonly pkce: PkceCodes;
}

interface CachedBrowserCompletion {
  readonly tokens: OAuthTokens;
  readonly expiresAt: number;
}

interface DeviceFlowState {
  readonly createdAt: number;
  readonly intervalMs: number;
  readonly userCode: string;
  nextPollAt: number;
  cachedResult?: DevicePollResult;
  cachedResultExpiresAt?: number;
  inFlight?: Promise<DevicePollResult>;
}

interface TokenResponse {
  readonly id_token?: string;
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly chatgpt_account_id?: string;
  readonly chatgpt_plan_type?: string;
}

interface DeviceAuthorizationResponse {
  readonly device_auth_id: string;
  readonly user_code: string;
  readonly interval: string;
}

interface DeviceTokenPollSuccess {
  readonly authorization_code: string;
  readonly code_verifier: string;
}

export interface BrowserAuthStartResponse {
  readonly authorizeUrl: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface DeviceAuthStartResponse {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly accountId: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

export type DevicePollResult =
  | { readonly state: "pending" }
  | { readonly state: "authorized"; readonly tokens: OAuthTokens }
  | { readonly state: "failed"; readonly reason: string };

interface JwtClaims {
  readonly sub?: string;
  readonly email?: string;
  readonly chatgpt_account_id?: string;
  readonly chatgpt_plan_type?: string;
  readonly organizations?: ReadonlyArray<{ readonly id: string }>;
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_plan_type?: string;
  };
  readonly "https://api.openai.com/profile"?: {
    readonly email?: string;
  };
}

interface OpenAiOAuthManagerOptions {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly browserStateTtlMs?: number;
  readonly browserCompletionTtlMs?: number;
  readonly deviceStateTtlMs?: number;
}

const DEFAULT_BROWSER_STATE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BROWSER_COMPLETION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_STATE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5000;

function generateRandomString(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((value) => alphabet[value % alphabet.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = Buffer.from(new Uint8Array(buffer));
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: JwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

function planTypeFromClaims(claims: JwtClaims): string | undefined {
  return (
    claims.chatgpt_plan_type ??
    claims["https://api.openai.com/auth"]?.chatgpt_plan_type
  );
}

function identityDiscriminatorFromClaims(claims: JwtClaims | undefined): string | undefined {
  const subject = claims?.sub?.trim();
  if (subject && subject.length > 0) {
    return `sub:${subject}`;
  }

  const email = claims?.email?.trim().toLowerCase()
    ?? claims?.["https://api.openai.com/profile"]?.email?.trim().toLowerCase();
  if (email && email.length > 0) {
    return `email:${email}`;
  }

  return undefined;
}

function storageAccountId(chatgptAccountId: string, discriminator: string): string {
  const digest = createHash("sha256")
    .update(chatgptAccountId)
    .update("\0")
    .update(discriminator)
    .digest("hex")
    .slice(0, 12);

  return `${chatgptAccountId}-${digest}`;
}

function emailFromClaims(claims: JwtClaims | undefined): string | undefined {
  const email = claims?.email?.trim().toLowerCase()
    ?? claims?.["https://api.openai.com/profile"]?.email?.trim().toLowerCase();
  return email && email.length > 0 ? email : undefined;
}

function subjectFromClaims(claims: JwtClaims | undefined): string | undefined {
  const subject = claims?.sub?.trim();
  return subject && subject.length > 0 ? subject : undefined;
}

function extractAccountIdentity(tokens: TokenResponse): {
  readonly accountId: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
} {
  const idTokenClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined;
  const accessClaims = parseJwtClaims(tokens.access_token);

  const chatgptAccountId = (idTokenClaims ? accountIdFromClaims(idTokenClaims) : undefined)
    ?? (accessClaims ? accountIdFromClaims(accessClaims) : undefined);
  const email = emailFromClaims(idTokenClaims) ?? emailFromClaims(accessClaims);
  const subject = subjectFromClaims(idTokenClaims) ?? subjectFromClaims(accessClaims);
  const discriminator = identityDiscriminatorFromClaims(idTokenClaims)
    ?? identityDiscriminatorFromClaims(accessClaims);

  if (chatgptAccountId && discriminator) {
    return {
      accountId: storageAccountId(chatgptAccountId, discriminator),
      chatgptAccountId,
      email,
      subject,
    };
  }

  if (chatgptAccountId) {
    return {
      accountId: chatgptAccountId,
      chatgptAccountId,
      email,
      subject,
    };
  }

  return {
    accountId: `openai-${Date.now()}`,
    email,
    subject,
  };
}

function buildAuthorizationUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "open-hax-openai-proxy",
    state,
  });

  return `${OPENAI_ISSUER}/oauth/authorize?${params.toString()}`;
}

function normalizeBrowserRedirectBaseUrl(redirectBaseUrl: string): string {
  const url = new URL(redirectBaseUrl);

  if (url.hostname === "127.0.0.1" || url.hostname === "::1") {
    url.hostname = "localhost";
  }

  url.port = OPENAI_BROWSER_CALLBACK_PORT;

  return url.toString();
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchFn: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchFn(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`OpenAI token exchange failed with status ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

function toOAuthTokens(tokens: TokenResponse): OAuthTokens {
  const identity = extractAccountIdentity(tokens);
  const idTokenClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined;
  const accessClaims = parseJwtClaims(tokens.access_token);
  const planType = tokens.chatgpt_plan_type
    ?? (idTokenClaims ? planTypeFromClaims(idTokenClaims) : undefined)
    ?? (accessClaims ? planTypeFromClaims(accessClaims) : undefined);

  return {
    accountId: identity.accountId,
    chatgptAccountId: identity.chatgptAccountId,
    email: identity.email,
    subject: identity.subject,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined,
    planType,
  };
}

export class OpenAiOAuthManager {
  private readonly browserPending = new Map<string, BrowserPendingState>();
  private readonly browserCompletions = new Map<string, CachedBrowserCompletion>();
  private readonly browserInFlight = new Map<string, Promise<OAuthTokens>>();
  private readonly deviceFlows = new Map<string, DeviceFlowState>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly browserStateTtlMs: number;
  private readonly browserCompletionTtlMs: number;
  private readonly deviceStateTtlMs: number;

  public constructor(options: OpenAiOAuthManagerOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.browserStateTtlMs = options.browserStateTtlMs ?? DEFAULT_BROWSER_STATE_TTL_MS;
    this.browserCompletionTtlMs = options.browserCompletionTtlMs ?? DEFAULT_BROWSER_COMPLETION_TTL_MS;
    this.deviceStateTtlMs = options.deviceStateTtlMs ?? DEFAULT_DEVICE_STATE_TTL_MS;
  }

  public async startBrowserFlow(redirectBaseUrl: string): Promise<BrowserAuthStartResponse> {
    const pkce = await generatePkce();
    const state = generateState();
    const normalizedBaseUrl = normalizeBrowserRedirectBaseUrl(redirectBaseUrl);
    const redirectUri = new URL("/auth/callback", normalizedBaseUrl).toString();

    this.browserPending.set(state, {
      createdAt: this.now(),
      redirectUri,
      pkce,
    });

    this.pruneState();

    return {
      state,
      redirectUri,
      authorizeUrl: buildAuthorizationUrl(redirectUri, pkce, state),
    };
  }

  public async completeBrowserFlow(state: string, code: string): Promise<OAuthTokens> {
    this.pruneState();

    const cachedCompletion = this.browserCompletions.get(state);
    if (cachedCompletion && cachedCompletion.expiresAt > this.now()) {
      return cachedCompletion.tokens;
    }

    const inFlightCompletion = this.browserInFlight.get(state);
    if (inFlightCompletion) {
      return inFlightCompletion;
    }

    const pending = this.browserPending.get(state);
    if (!pending) {
      throw new Error("Unknown or expired OAuth state");
    }

    this.browserPending.delete(state);
    const completion = exchangeAuthorizationCode(code, pending.redirectUri, pending.pkce.verifier, this.fetchFn)
      .then((tokens) => {
        const oauthTokens = toOAuthTokens(tokens);
        this.browserCompletions.set(state, {
          tokens: oauthTokens,
          expiresAt: this.now() + this.browserCompletionTtlMs,
        });
        return oauthTokens;
      })
      .finally(() => {
        this.browserInFlight.delete(state);
      });

    this.browserInFlight.set(state, completion);
    return completion;
  }

  public async startDeviceFlow(): Promise<DeviceAuthStartResponse> {
    this.pruneState();

    const response = await this.fetchFn(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: OPENAI_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI device authorization failed with status ${response.status}`);
    }

    const payload = (await response.json()) as DeviceAuthorizationResponse;
    const intervalSeconds = Number.parseInt(payload.interval, 10);
    const intervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds * 1000
      : DEFAULT_DEVICE_POLL_INTERVAL_MS;

    this.deviceFlows.set(payload.device_auth_id, {
      createdAt: this.now(),
      intervalMs,
      userCode: payload.user_code,
      nextPollAt: 0,
    });

    return {
      verificationUrl: `${OPENAI_ISSUER}/codex/device`,
      userCode: payload.user_code,
      deviceAuthId: payload.device_auth_id,
      intervalMs,
    };
  }

  public async pollDeviceFlow(deviceAuthId: string, userCode: string): Promise<DevicePollResult> {
    this.pruneState();

    const deviceFlow = this.deviceFlows.get(deviceAuthId) ?? {
      createdAt: this.now(),
      intervalMs: DEFAULT_DEVICE_POLL_INTERVAL_MS,
      userCode,
      nextPollAt: 0,
    };
    this.deviceFlows.set(deviceAuthId, deviceFlow);

    const now = this.now();
    if (deviceFlow.cachedResult && typeof deviceFlow.cachedResultExpiresAt === "number" && deviceFlow.cachedResultExpiresAt > now) {
      return deviceFlow.cachedResult;
    }

    if (deviceFlow.inFlight) {
      return deviceFlow.inFlight;
    }

    if (now < deviceFlow.nextPollAt) {
      return { state: "pending" };
    }

    const pollPromise = this.pollDeviceFlowUncached(deviceAuthId, userCode, deviceFlow)
      .finally(() => {
        const latest = this.deviceFlows.get(deviceAuthId);
        if (latest) {
          latest.inFlight = undefined;
        }
      });

    deviceFlow.inFlight = pollPromise;
    return pollPromise;
  }

  private async pollDeviceFlowUncached(
    deviceAuthId: string,
    userCode: string,
    deviceFlow: DeviceFlowState,
  ): Promise<DevicePollResult> {
    const response = await this.fetchFn(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (response.ok) {
      const payload = (await response.json()) as DeviceTokenPollSuccess;
      const tokens = await exchangeAuthorizationCode(
        payload.authorization_code,
        `${OPENAI_ISSUER}/deviceauth/callback`,
        payload.code_verifier,
        this.fetchFn,
      );
      const result: DevicePollResult = {
        state: "authorized",
        tokens: toOAuthTokens(tokens),
      };
      deviceFlow.cachedResult = result;
      deviceFlow.cachedResultExpiresAt = this.now() + this.deviceStateTtlMs;
      return result;
    }

    if (response.status === 403 || response.status === 404) {
      deviceFlow.nextPollAt = this.now() + deviceFlow.intervalMs;
      return { state: "pending" };
    }

    return {
      state: "failed",
      reason: `OpenAI device authorization poll failed with status ${response.status}`,
    };
  }

  public async refreshToken(refreshToken: string): Promise<OAuthTokens> {
    const response = await this.fetchFn(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OpenAI token refresh failed with status ${response.status}`);
    }

    const tokens = (await response.json()) as TokenResponse;
    return toOAuthTokens(tokens);
  }

  public isTokenExpired(expiresAt: number | undefined, bufferMs: number = 60000): boolean {
    if (typeof expiresAt !== "number") {
      return false;
    }
    return this.now() >= expiresAt - bufferMs;
  }

  private pruneState(): void {
    const browserCutoff = this.now() - this.browserStateTtlMs;
    for (const [state, pending] of this.browserPending.entries()) {
      if (pending.createdAt < browserCutoff) {
        this.browserPending.delete(state);
      }
    }

    const browserCompletionNow = this.now();
    for (const [state, completion] of this.browserCompletions.entries()) {
      if (completion.expiresAt <= browserCompletionNow) {
        this.browserCompletions.delete(state);
      }
    }

    const deviceCutoff = this.now() - this.deviceStateTtlMs;
    for (const [deviceAuthId, deviceFlow] of this.deviceFlows.entries()) {
      if (deviceFlow.createdAt < deviceCutoff && !deviceFlow.inFlight) {
        this.deviceFlows.delete(deviceAuthId);
      }
    }
  }
}
