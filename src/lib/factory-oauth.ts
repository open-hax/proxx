import { randomUUID } from "node:crypto";

import { kernels } from "./cljs-kernels.js";

/**
 * Factory.ai OAuth manager — WorkOS device flow and browser flow, following the
 * same pattern as OpenAiOAuthManager. The flow tables, polling decisions and
 * token mapping are CLJS (`proxx.oauth.flow`, `proxx.oauth.factory`); the
 * stateful edge is `proxx.runtime.oauth`. This class only forwards.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FactoryOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly email?: string;
  readonly expiresAt?: number;
}

export interface FactoryDeviceAuthStartResponse {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
}

export type FactoryDevicePollResult =
  | { readonly state: "pending" }
  | { readonly state: "authorized"; readonly tokens: FactoryOAuthTokens }
  | { readonly state: "failed"; readonly reason: string };

export interface FactoryBrowserAuthStartResponse {
  readonly authorizeUrl: string;
  readonly state: string;
}

interface FactoryOAuthManagerOptions {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly deviceStateTtlMs?: number;
  readonly browserStateTtlMs?: number;
  readonly browserCompletionTtlMs?: number;
}

interface FactoryManagerFacade {
  startDeviceFlow(): Promise<FactoryDeviceAuthStartResponse>;
  pollDeviceFlow(deviceAuthId: string): Promise<FactoryDevicePollResult>;
  startBrowserFlow(redirectUri: string): FactoryBrowserAuthStartResponse;
  completeBrowserFlow(state: string, code: string): Promise<FactoryOAuthTokens>;
}

export class FactoryOAuthManager {
  private readonly impl: FactoryManagerFacade;

  public constructor(options: FactoryOAuthManagerOptions = {}) {
    this.impl = kernels.createFactoryOAuthManager(options, {
      fetchFn: options.fetchFn ?? fetch,
      now: options.now ?? (() => Date.now()),
      randomUUID: () => randomUUID(),
    }) as unknown as FactoryManagerFacade;
  }

  /** Start the WorkOS device authorization flow. */
  public startDeviceFlow(): Promise<FactoryDeviceAuthStartResponse> {
    return this.impl.startDeviceFlow();
  }

  /** Poll the WorkOS authenticate endpoint for the device flow completion. */
  public pollDeviceFlow(deviceAuthId: string): Promise<FactoryDevicePollResult> {
    return this.impl.pollDeviceFlow(deviceAuthId);
  }

  /** Start the WorkOS browser (authorization code) flow. */
  public startBrowserFlow(redirectUri: string): FactoryBrowserAuthStartResponse {
    return this.impl.startBrowserFlow(redirectUri);
  }

  /** Complete the browser flow by exchanging the authorization code for tokens. */
  public completeBrowserFlow(state: string, code: string): Promise<FactoryOAuthTokens> {
    return this.impl.completeBrowserFlow(state, code);
  }
}
