import type { CredentialAccountView, CredentialStoreLike } from "./credential-store.js";
import { ollamaToChatCompletion } from "./ollama-compat.js";

const OLLAMA_CLOUD_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_OLLAMA_CLOUD_PROBE_MODEL = "glm-5";
const DEFAULT_OLLAMA_CLOUD_PROBE_EXPECTED_TEXT = "hello";

export interface CredentialAccountProbeResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractCompletionText(completion: Record<string, unknown>): string {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return "";
  }

  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  return asString(message?.content)?.trim() ?? "";
}

function responseErrorMessage(responseStatus: number, responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return `HTTP ${responseStatus}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      const message = asString(parsed.message)
        ?? (isRecord(parsed.error) ? asString(parsed.error.message) ?? asString(parsed.error) : undefined)
        ?? asString(parsed.detail);
      if (message && message.trim().length > 0) {
        return message.trim();
      }
    }
  } catch {
    // Fall through to plain text.
  }

  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function responseErrorCode(responseText: string): string | undefined {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const error = isRecord(parsed.error) ? parsed.error : undefined;
    const code = (asString(error?.code) ?? asString(parsed.code))?.trim().toLowerCase();
    return code && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

function buildProbePayload(model: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: "Reply with exactly hello." }],
    stream: false,
    think: false,
  };
}

async function findApiKeyAccount(
  credentialStore: CredentialStoreLike,
  providerId: string,
  accountId: string,
): Promise<CredentialAccountView | null> {
  const providers = await credentialStore.listProviders(true);
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return null;
  }

  const account = provider.accounts.find((entry) => entry.id === accountId && entry.authType === "api_key");
  return account ?? null;
}

function buildErrorResult(
  providerId: string,
  account: CredentialAccountView,
  testedAt: string,
  model: string,
  message: string,
  upstreamStatus?: number,
  errorCode?: string,
): CredentialAccountProbeResult {
  return {
    providerId,
    accountId: account.id,
    displayName: account.displayName,
    email: account.email,
    planType: account.planType,
    chatgptAccountId: account.chatgptAccountId,
    testedAt,
    model,
    expectedText: DEFAULT_OLLAMA_CLOUD_PROBE_EXPECTED_TEXT,
    status: "error",
    ok: false,
    matchesExpectedOutput: false,
    upstreamStatus,
    errorCode,
    message,
  };
}

export async function probeOllamaCloudAccount(
  credentialStore: CredentialStoreLike,
  options: {
    readonly providerId: string;
    readonly accountId: string;
    readonly baseUrl: string;
    readonly model?: string;
    readonly fetchFn?: typeof fetch;
  },
): Promise<CredentialAccountProbeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const testedAt = new Date().toISOString();
  const model = options.model?.trim() || DEFAULT_OLLAMA_CLOUD_PROBE_MODEL;
  const account = await findApiKeyAccount(credentialStore, options.providerId, options.accountId);

  if (!account) {
    throw new Error(`Ollama Cloud account not found: ${options.accountId}`);
  }

  const apiKey = account.secret?.trim();
  if (!apiKey) {
    return buildErrorResult(options.providerId, account, testedAt, model, "Missing API key.", 401, "missing_api_key");
  }

  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, OLLAMA_CLOUD_PROBE_TIMEOUT_MS);

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildProbePayload(model)),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      return buildErrorResult(
        options.providerId,
        account,
        testedAt,
        model,
        responseErrorMessage(response.status, responseText),
        response.status,
        responseErrorCode(responseText),
      );
    }

    let payload: unknown;
    try {
      payload = responseText.length > 0 ? JSON.parse(responseText) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildErrorResult(options.providerId, account, testedAt, model, `Invalid Ollama Cloud response: ${message}`, response.status);
    }

    try {
      const completion = ollamaToChatCompletion(payload, model);
      const outputText = extractCompletionText(completion);
      const matchesExpectedOutput = outputText.toLowerCase() === DEFAULT_OLLAMA_CLOUD_PROBE_EXPECTED_TEXT;
      const message = matchesExpectedOutput
        ? `Live — replied with ${JSON.stringify(outputText || DEFAULT_OLLAMA_CLOUD_PROBE_EXPECTED_TEXT)}.`
        : outputText.length > 0
          ? `Live — replied with ${JSON.stringify(outputText)}.`
          : "Live — request completed without assistant text.";

      return {
        providerId: options.providerId,
        accountId: account.id,
        displayName: account.displayName,
        email: account.email,
        planType: account.planType,
        chatgptAccountId: account.chatgptAccountId,
        testedAt,
        model,
        expectedText: DEFAULT_OLLAMA_CLOUD_PROBE_EXPECTED_TEXT,
        status: "ok",
        ok: true,
        matchesExpectedOutput,
        outputText: outputText || undefined,
        upstreamStatus: response.status,
        message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildErrorResult(options.providerId, account, testedAt, model, message, response.status);
    }
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "Ollama Cloud probe timed out."
      : error instanceof Error
        ? error.message
        : String(error);
    return buildErrorResult(options.providerId, account, testedAt, model, message);
  } finally {
    clearTimeout(timeout);
  }
}