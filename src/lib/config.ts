import { resolve } from "node:path";

export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstreamProviderId: string;
  readonly upstreamFallbackProviderIds: readonly string[];
  readonly disabledProviderIds: readonly string[];
  readonly upstreamProviderBaseUrls: Readonly<Record<string, string>>;
  readonly upstreamBaseUrl: string;
  readonly openaiProviderId: string;
  readonly openaiBaseUrl: string;
  readonly ollamaBaseUrl: string;
  readonly localOllamaEnabled: boolean;
  readonly localOllamaModelPatterns: readonly string[];
  readonly chatCompletionsPath: string;
  readonly openaiChatCompletionsPath: string;
  readonly messagesPath: string;
  readonly messagesModelPrefixes: readonly string[];
  readonly messagesInterleavedThinkingBeta?: string;
  readonly responsesPath: string;
  readonly openaiResponsesPath: string;
  readonly responsesModelPrefixes: readonly string[];
  readonly ollamaChatPath: string;
  readonly ollamaV1ChatPath: string;
  readonly factoryModelPrefixes: readonly string[];
  readonly openaiModelPrefixes: readonly string[];
  readonly ollamaModelPrefixes: readonly string[];
  readonly keysFilePath: string;
  readonly modelsFilePath: string;
  readonly requestLogsFilePath: string;
  readonly promptAffinityFilePath: string;
  readonly settingsFilePath: string;
  readonly keyReloadMs: number;
  readonly keyCooldownMs: number;
  readonly requestTimeoutMs: number;
  readonly streamBootstrapTimeoutMs: number;
  readonly upstreamTransientRetryCount: number;
  readonly upstreamTransientRetryBackoffMs: number;
  readonly proxyAuthToken?: string;
  readonly allowUnauthenticated: boolean;
  readonly policyConfigPath?: string;
  readonly databaseUrl?: string;
  readonly githubOAuthClientId?: string;
  readonly githubOAuthClientSecret?: string;
  readonly githubOAuthCallbackPath: string;
  readonly githubAllowedUsers: readonly string[];
  readonly sessionSecret: string;
}

export const DEFAULT_MODELS: readonly string[] = [
  "gpt-5.4",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "claude-opus-4-5",
  "gpt-5.3-codex",
  "gemini-3-flash-preview",
  "gpt-5.2",
  "DeepSeek-V3.2",
  "gemini-3-pro-preview",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "glm-5",
  "Kimi-K2.5",
  "gemini-3.1-pro-preview",
  "qwen3.5:4b-q8_0",
  "qwen3.5:2b-bf16"
];

function numberFromEnvAliases(names: readonly string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      continue;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
    }

    return parsed;
  }

  return fallback;
}

function optionalFilePathFromEnvAliases(names: readonly string[], cwd: string): string | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string" && raw.length > 0) {
      return resolve(cwd, raw);
    }
  }

  return undefined;
}

function nonNegativeNumberFromEnvAliases(names: readonly string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      continue;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
    }

    return parsed;
  }

  return fallback;
}

function filePathFromEnvAliases(names: readonly string[], fallback: string, cwd: string): string {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string" && raw.length > 0) {
      return resolve(cwd, raw);
    }
  }

  return resolve(cwd, fallback);
}

function booleanFromEnvAliases(names: readonly string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      continue;
    }

    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }

    throw new Error(`Invalid boolean environment variable ${name}: ${raw}`);
  }

  return fallback;
}

function csvFromEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) {
    return [...fallback];
  }

  if (raw === "") {
    return [];
  }

  const items = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return items;
}

function normalizeProviderList(values: readonly string[]): string[] {
  return [...new Set(
    values
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )];
}

function providerBaseUrlsFromEnv(
  name: string,
  fallback: Readonly<Record<string, string>>
): Record<string, string> {
  const parsed: Record<string, string> = { ...fallback };
  const raw = process.env[name];
  if (!raw) {
    return parsed;
  }

  for (const item of raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === item.length - 1) {
      throw new Error(`Invalid provider base URL mapping in ${name}: ${item}`);
    }

    const providerId = item.slice(0, separatorIndex).trim();
    const baseUrl = item.slice(separatorIndex + 1).trim().replace(/\/+$/, "");
    if (providerId.length === 0 || baseUrl.length === 0) {
      throw new Error(`Invalid provider base URL mapping in ${name}: ${item}`);
    }

    parsed[providerId] = baseUrl;
  }

  return parsed;
}

function defaultProviderBaseUrl(providerId: string): string {
  switch (providerId.trim()) {
    case "factory":
      return (process.env.FACTORY_BASE_URL ?? "https://api.factory.ai").replace(/\/+$/, "");
    case "openrouter":
      return (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    case "requesty":
      return (process.env.REQUESTY_BASE_URL ?? "https://router.requesty.ai/v1").replace(/\/+$/, "");
    case "ollama-cloud":
      return "https://ollama.com";
    case "vivgrid":
    default:
      return "https://api.vivgrid.com";
  }
}

export function loadConfig(cwd: string = process.cwd()): ProxyConfig {
  const upstreamProviderId = (process.env.UPSTREAM_PROVIDER_ID ?? "vivgrid").trim();
  const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? defaultProviderBaseUrl(upstreamProviderId)).replace(/\/+$/, "");
  const defaultFallbackProviders = upstreamProviderId === "vivgrid"
    ? ["ollama-cloud"]
    : upstreamProviderId === "ollama-cloud"
      ? ["vivgrid"]
      : [];
  const rawFallbackProviders = process.env.UPSTREAM_FALLBACK_PROVIDER_IDS;
  const parsedFallbackProviders = rawFallbackProviders === undefined
    ? [...defaultFallbackProviders]
    : rawFallbackProviders
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  const disabledProviderIds = normalizeProviderList(csvFromEnv("DISABLED_PROVIDER_IDS", []));
  const disabledProviderSet = new Set(disabledProviderIds);
  const upstreamFallbackProviderIds = normalizeProviderList(
    parsedFallbackProviders.filter((entry) => entry !== upstreamProviderId && !disabledProviderSet.has(entry))
  );
  const upstreamProviderBaseUrls = providerBaseUrlsFromEnv("UPSTREAM_PROVIDER_BASE_URLS", {
    vivgrid: "https://api.vivgrid.com",
    "ollama-cloud": "https://ollama.com",
    openrouter: defaultProviderBaseUrl("openrouter"),
    requesty: defaultProviderBaseUrl("requesty"),
    factory: defaultProviderBaseUrl("factory"),
  });
  upstreamProviderBaseUrls[upstreamProviderId] = upstreamBaseUrl;
  const openaiProviderId = (process.env.OPENAI_PROVIDER_ID ?? "openai").trim();
  const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL ?? "http://ollama:11434").replace(/\/+$/, "");
  const rawMessagesInterleavedThinkingBeta = process.env.UPSTREAM_MESSAGES_INTERLEAVED_THINKING_BETA;
  const messagesInterleavedThinkingBeta = rawMessagesInterleavedThinkingBeta === undefined
    ? "interleaved-thinking-2025-05-14"
    : rawMessagesInterleavedThinkingBeta.trim();
  const rawProxyAuthToken = process.env.PROXY_AUTH_TOKEN?.trim();
  const proxyAuthToken = typeof rawProxyAuthToken === "string" && rawProxyAuthToken.length > 0
    ? rawProxyAuthToken
    : undefined;
  const allowUnauthenticated = booleanFromEnvAliases(
    ["PROXY_ALLOW_UNAUTHENTICATED", "VIVGRID_ALLOW_UNAUTHENTICATED"],
    false
  );

  if (!proxyAuthToken && !allowUnauthenticated) {
    throw new Error("PROXY_AUTH_TOKEN is required unless PROXY_ALLOW_UNAUTHENTICATED=true");
  }

  if (upstreamProviderId.length === 0) {
    throw new Error("UPSTREAM_PROVIDER_ID must not be empty");
  }

  if (openaiProviderId.length === 0) {
    throw new Error("OPENAI_PROVIDER_ID must not be empty");
  }

  const localOllamaEnabled = booleanFromEnvAliases(["LOCAL_OLLAMA_ENABLED"], true);
  const localOllamaModelPatterns = csvFromEnv("LOCAL_OLLAMA_MODEL_PATTERNS", [
    ":2b",
    ":2b-",
    ":3b",
    ":3b-",
    ":4b",
    ":4b-",
    ":7b",
    ":7b-",
    ":8b",
    ":8b-",
    "mini",
    "small"
  ]);

  const databaseUrlRaw = process.env.DATABASE_URL?.trim();
  const databaseUrl = databaseUrlRaw && databaseUrlRaw.length > 0 ? databaseUrlRaw : undefined;

  const githubOAuthClientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || undefined;
  const githubOAuthClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() || undefined;
  const githubOAuthCallbackPath = process.env.GITHUB_OAUTH_CALLBACK_PATH?.trim() || "/auth/github/callback";
  const githubAllowedUsers = csvFromEnv("GITHUB_ALLOWED_USERS", []);

  const sessionSecretRaw = process.env.SESSION_SECRET?.trim();
  const sessionSecret = sessionSecretRaw && sessionSecretRaw.length > 0
    ? sessionSecretRaw
    : proxyAuthToken ?? "default-session-secret-change-in-production";

  return {
    host: process.env.PROXY_HOST ?? process.env.HOST ?? "127.0.0.1",
    port: numberFromEnvAliases(["PROXY_PORT", "PORT"], 8789),
    upstreamProviderId,
    upstreamFallbackProviderIds,
    disabledProviderIds,
    upstreamProviderBaseUrls,
    upstreamBaseUrl,
    openaiProviderId,
    openaiBaseUrl,
    ollamaBaseUrl,
    localOllamaEnabled,
    localOllamaModelPatterns,
    chatCompletionsPath: process.env.UPSTREAM_CHAT_COMPLETIONS_PATH ?? "/v1/chat/completions",
    openaiChatCompletionsPath: process.env.OPENAI_CHAT_COMPLETIONS_PATH ?? "/codex/responses/compact",
    messagesPath: process.env.UPSTREAM_MESSAGES_PATH ?? "/v1/messages",
    messagesModelPrefixes: csvFromEnv("UPSTREAM_MESSAGES_MODEL_PREFIXES", ["claude-"]),
    messagesInterleavedThinkingBeta: messagesInterleavedThinkingBeta.length > 0
      ? messagesInterleavedThinkingBeta
      : undefined,
    responsesPath: process.env.UPSTREAM_RESPONSES_PATH ?? "/v1/responses",
    openaiResponsesPath: process.env.OPENAI_RESPONSES_PATH ?? "/codex/responses",
    responsesModelPrefixes: csvFromEnv("UPSTREAM_RESPONSES_MODEL_PREFIXES", ["gpt-"]),
    ollamaChatPath: process.env.OLLAMA_CHAT_PATH ?? "/api/chat",
    ollamaV1ChatPath: process.env.OLLAMA_V1_CHAT_PATH ?? "/v1/chat/completions",
    factoryModelPrefixes: csvFromEnv("FACTORY_MODEL_PREFIXES", ["factory/", "factory:"]),
    openaiModelPrefixes: csvFromEnv("OPENAI_MODEL_PREFIXES", ["openai/", "openai:"]),
    ollamaModelPrefixes: csvFromEnv("OLLAMA_MODEL_PREFIXES", ["ollama/", "ollama:"]),
    keysFilePath: optionalFilePathFromEnvAliases(["PROXY_KEYS_FILE", "VIVGRID_KEYS_FILE"], cwd)
      ?? filePathFromEnvAliases(["PROXY_KEYS_FILE", "VIVGRID_KEYS_FILE"], "./keys.json", cwd),
    modelsFilePath: filePathFromEnvAliases(["PROXY_MODELS_FILE", "VIVGRID_MODELS_FILE"], "./models.json", cwd),
    requestLogsFilePath: filePathFromEnvAliases(["PROXY_REQUEST_LOGS_FILE"], "./data/request-logs.json", cwd),
    promptAffinityFilePath: filePathFromEnvAliases(["PROXY_PROMPT_AFFINITY_FILE"], "./data/prompt-affinity.json", cwd),
    settingsFilePath: filePathFromEnvAliases(["PROXY_SETTINGS_FILE"], "./data/proxy-settings.json", cwd),
    keyReloadMs: numberFromEnvAliases(["PROXY_KEY_RELOAD_MS", "VIVGRID_KEY_RELOAD_MS"], 5000),
    keyCooldownMs: numberFromEnvAliases(["PROXY_KEY_COOLDOWN_MS", "VIVGRID_KEY_RELOAD_MS"], 30000),
    requestTimeoutMs: numberFromEnvAliases(["UPSTREAM_REQUEST_TIMEOUT_MS"], 180000),
    streamBootstrapTimeoutMs: numberFromEnvAliases(["UPSTREAM_STREAM_BOOTSTRAP_TIMEOUT_MS"], 8000),
    upstreamTransientRetryCount: nonNegativeNumberFromEnvAliases(["UPSTREAM_TRANSIENT_RETRY_COUNT"], 2),
    upstreamTransientRetryBackoffMs: numberFromEnvAliases(["UPSTREAM_TRANSIENT_RETRY_BACKOFF_MS"], 350),
    proxyAuthToken,
    allowUnauthenticated,
    policyConfigPath: process.env.PROXY_POLICY_CONFIG_FILE ?? undefined,
    databaseUrl,
    githubOAuthClientId,
    githubOAuthClientSecret,
    githubOAuthCallbackPath,
    githubAllowedUsers,
    sessionSecret,
  };
}
