import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * Proxy configuration. The environment-to-config function is pure CLJS
 * (`proxx.config.proxy`, Malli-validated by `proxx.runtime.config`); upstream
 * base URLs, default prefixes/paths/OAuth values and the default model catalogue
 * are policy facts (`06-proxy-config-defaults.edn`). Environment variables always
 * override them.
 */
export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstreamProviderId: string;
  readonly disabledProviderIds: readonly string[];
  readonly upstreamProviderBaseUrls: Readonly<Record<string, string>>;
  readonly upstreamBaseUrl: string;
  readonly openaiProviderId: string;
  readonly openaiBaseUrl: string;
  /** OpenAI Platform API base URL (e.g. https://api.openai.com). */
  readonly openaiApiBaseUrl: string;

  /**
   * Determines where OpenAI image generation requests are sent when routing to the OpenAI provider.
   *
   * - `platform`: Use the OpenAI Platform Images API (`OPENAI_API_BASE_URL`, default https://api.openai.com).
   *   - Works with API keys.
   *   - For OAuth bearer tokens, requires Platform API scopes (e.g. model/images scopes).
   *
   * - `chatgpt`: Use the ChatGPT/Codex backend Responses API (`OPENAI_BASE_URL` + `OPENAI_RESPONSES_PATH`).
   *   - Sends a Responses request that forces the built-in `image_generation` tool.
   *   - Translates `image_generation_call` items back into an Images API-compatible JSON response.
   *   - Intended for ChatGPT-subscription-backed OAuth tokens.
   *   - Endpoint paths are not guaranteed stable.
   *
   * - `auto`: Try `platform` first, then fall back to `chatgpt` on 401/403.
   */
  readonly openaiImagesUpstreamMode: "platform" | "chatgpt" | "auto";
  readonly ollamaBaseUrl: string;
  readonly ollamaApiKey?: string;
  readonly localOllamaEnabled: boolean;
  readonly localOllamaModelPatterns: readonly string[];
  readonly chatCompletionsPath: string;
  readonly openaiChatCompletionsPath: string;
  readonly messagesPath: string;
  readonly messagesModelPrefixes: readonly string[];
  readonly messagesInterleavedThinkingBeta?: string;
  readonly responsesPath: string;
  readonly openaiResponsesPath: string;
  /**
   * Upstream paths to try for OpenAI OAuth-backed image generation.
   *
   * The proxy's OpenAI OAuth accounts commonly target ChatGPT's backend API
   * (`OPENAI_BASE_URL=https://chatgpt.com/backend-api`), which does not
   * necessarily expose the same Images endpoint paths as api.openai.com.
   *
   * NOTE: as of 2026-03, OpenAI image generation routing primarily targets the
   * Platform Images API, or uses Codex Responses image generation under
   * `OPENAI_IMAGES_UPSTREAM_MODE=chatgpt|auto`. These paths are kept for
   * backwards compatibility.
   */
  readonly openaiImagesGenerationsPaths: readonly string[];
  /** Default USD cost per image (used when no provider override is set). */
  readonly imageCostUsdDefault: number;
  /** Optional per-provider USD cost per image overrides. */
  readonly imageCostUsdByProvider: Readonly<Record<string, number>>;
  readonly imagesGenerationsPath: string;
  readonly responsesModelPrefixes: readonly string[];
  readonly ollamaChatPath: string;
  readonly ollamaV1ChatPath: string;
  readonly factoryModelPrefixes: readonly string[];
  readonly openaiModelPrefixes: readonly string[];
  readonly ollamaModelPrefixes: readonly string[];
  readonly llamacppModelPrefixes?: readonly string[];
  readonly keysFilePath: string;
  readonly modelsFilePath: string;
  readonly requestLogsFilePath: string;
  readonly requestLogsMaxEntries: number;
  readonly requestLogsFlushMs: number;
  readonly promptAffinityFilePath: string;
  readonly promptAffinityFlushMs: number;
  readonly settingsFilePath: string;
  readonly keyReloadMs: number;
  readonly keyCooldownMs: number;
  readonly keyCooldownJitterFactor: number;
  readonly enableKeyRandomWalk: boolean;
  readonly ollamaWeeklyCooldownMultiplier: number;
  readonly requestTimeoutMs: number;
  readonly streamBootstrapTimeoutMs: number;
  readonly embedMaxContextTokens: number;
  readonly embedMaxBatchItems: number;
  readonly embedMaxInputChars: number;
  readonly upstreamTransientRetryCount: number;
  readonly upstreamTransientRetryBackoffMs: number;

  /** Maximum retries on the same credential when a concurrency-throttle 429 is received. */
  readonly concurrencyThrottleMaxRetries: number;

  /** Rate-limit responses with retry-after ≤ this value (ms) are classified as
   *  concurrency throttles rather than quota exhaustion. */
  readonly concurrencyThrottleThresholdMs: number;
  readonly proxyAuthToken?: string;
  readonly proxyTokenPepper: string;
  readonly allowUnauthenticated: boolean;
  readonly policyConfigPath?: string;
  readonly cljsPolicyManifestPath?: string;
  readonly cljsPolicyShadowMode?: boolean;
  readonly cljsPolicyAuthoritative?: boolean;
  readonly databaseUrl?: string;
  readonly githubOAuthClientId?: string;
  readonly githubOAuthClientSecret?: string;
  readonly githubOAuthCallbackPath: string;
  readonly githubAllowedUsers: readonly string[];
  readonly sessionSecret: string;

  /** OAuth scopes requested during OpenAI browser authorization. */
  readonly openaiOauthScopes: string;

  /** OAuth client id used for OpenAI browser/device auth flows. */
  readonly openaiOauthClientId: string;

  /** OAuth issuer base URL used for OpenAI browser/device auth flows. */
  readonly openaiOauthIssuer: string;

  /** OAuth client secret used for OpenAI token exchange/refresh (optional). */
  readonly openaiOauthClientSecret?: string;

  /** Preserve non-loopback OpenAI browser OAuth callbacks instead of forcing localhost callback topology. */
  readonly openaiOauthAllowHostRoutedCallbacks?: boolean;

  /** Max concurrent OAuth refreshes allowed during background/manual refresh work. */
  readonly oauthRefreshMaxConcurrency: number;

  /** Background interval for proactive OAuth refresh scans. */
  readonly oauthRefreshBackgroundIntervalMs: number;

  /** Window used when proactively refreshing soon-expiring OAuth accounts. */
  readonly oauthRefreshProactiveWindowMs: number;
}

export const DEFAULT_MODELS: readonly string[] = kernels.defaultModels(policyManifestPath());

/**
 * Build a complete proxy configuration from the process environment.
 *
 * @param cwd - Base directory used to resolve any relative filesystem paths read from environment variables
 * @returns A fully populated `ProxyConfig`
 * @throws If neither `PROXY_AUTH_TOKEN` is set nor unauthenticated access is allowed, if required provider IDs are empty, or if a numeric/boolean variable is malformed
 */
export function loadConfig(cwd: string = process.cwd()): ProxyConfig {
  return kernels.loadConfig(process.env, cwd, policyManifestPath());
}
