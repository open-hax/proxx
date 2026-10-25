import { kernels } from "./cljs-kernels.js";

/**
 * OpenAI (ChatGPT/Codex) OAuth. PKCE, authorize/token request construction,
 * claim-to-identity mapping, expiry arithmetic, refresh-error classification
 * and the browser/device flow state machine are CLJS (`proxx.oauth.openai`,
 * `proxx.oauth.flow`); HTTP, the clock and randomness are its edge
 * (`proxx.runtime.oauth`). This module keeps the public types and class names.
 */

const OPENAI_BROWSER_CALLBACK_PORT = kernels.resolveOpenAiCallbackPort(process.env.OPENAI_OAUTH_CALLBACK_PORT);

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

export class OpenAiOAuthRefreshError extends Error {
  public readonly status: number;

  public readonly code?: string;

  public readonly type?: string;

  public readonly responseBody?: string;

  public constructor(
    status: number,
    message: string,
    options?: {
      readonly code?: string;
      readonly type?: string;
      readonly responseBody?: string;
    },
  ) {
    super(message);
    this.name = "OpenAiOAuthRefreshError";
    this.status = status;
    this.code = options?.code;
    this.type = options?.type;
    this.responseBody = options?.responseBody;
  }
}

export function isTerminalOpenAiRefreshError(error: unknown): error is OpenAiOAuthRefreshError {
  if (!(error instanceof OpenAiOAuthRefreshError)) {
    return false;
  }

  return kernels.isTerminalOpenAiRefreshErrorFacts({
    status: error.status,
    code: error.code,
    type: error.type,
    message: error.message,
    responseBody: error.responseBody,
  });
}

export type DevicePollResult =
  | { readonly state: "pending" }
  | { readonly state: "authorized"; readonly tokens: OAuthTokens }
  | { readonly state: "failed"; readonly reason: string };

interface OpenAiOAuthManagerOptions {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly browserStateTtlMs?: number;
  readonly browserCompletionTtlMs?: number;
  readonly deviceStateTtlMs?: number;
  /** Preserve non-loopback browser callbacks instead of forcing Codex-style localhost topology. */
  readonly allowHostRoutedCallbacks?: boolean;
  /** OAuth scopes used for the browser authorization URL. */
  readonly oauthScopes?: string;
  /** OAuth client ID (defaults to the bundled ChatGPT/Codex CLI client id). */
  readonly clientId?: string;
  /** OAuth issuer base URL (defaults to https://auth.openai.com). */
  readonly issuer?: string;

  /** OAuth client secret for token exchange/refresh (optional; PKCE public clients can omit). */
  readonly clientSecret?: string;
}

interface OpenAiManagerFacade {
  startBrowserFlow(redirectBaseUrl: string): Promise<BrowserAuthStartResponse>;
  completeBrowserFlow(state: string, code: string): Promise<OAuthTokens>;
  startDeviceFlow(): Promise<DeviceAuthStartResponse>;
  pollDeviceFlow(deviceAuthId: string, userCode: string): Promise<DevicePollResult>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  isTokenExpired(expiresAt: number | undefined, bufferMs?: number): boolean;
}

export class OpenAiOAuthManager {
  private readonly impl: OpenAiManagerFacade;

  public constructor(options: OpenAiOAuthManagerOptions = {}) {
    this.impl = kernels.createOpenAiOAuthManager(options, {
      fetchFn: options.fetchFn ?? fetch,
      now: options.now ?? (() => Date.now()),
      callbackPort: OPENAI_BROWSER_CALLBACK_PORT,
      randomBytes: (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length)),
      makeRefreshError: (
        status: number,
        message: string,
        details: { readonly code?: string; readonly type?: string; readonly responseBody?: string },
      ): OpenAiOAuthRefreshError => new OpenAiOAuthRefreshError(status, message, details),
    }) as unknown as OpenAiManagerFacade;
  }

  public startBrowserFlow(redirectBaseUrl: string): Promise<BrowserAuthStartResponse> {
    return this.impl.startBrowserFlow(redirectBaseUrl);
  }

  public completeBrowserFlow(state: string, code: string): Promise<OAuthTokens> {
    return this.impl.completeBrowserFlow(state, code);
  }

  public startDeviceFlow(): Promise<DeviceAuthStartResponse> {
    return this.impl.startDeviceFlow();
  }

  public pollDeviceFlow(deviceAuthId: string, userCode: string): Promise<DevicePollResult> {
    return this.impl.pollDeviceFlow(deviceAuthId, userCode);
  }

  public refreshToken(refreshToken: string): Promise<OAuthTokens> {
    return this.impl.refreshToken(refreshToken);
  }

  public isTokenExpired(expiresAt: number | undefined, bufferMs: number = 60000): boolean {
    return this.impl.isTokenExpired(expiresAt, bufferMs);
  }
}
