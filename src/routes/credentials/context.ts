import { FactoryOAuthManager } from "../../lib/factory-oauth.js";
import { OpenAiOAuthManager } from "../../lib/openai-oauth.js";
import type { UiRouteDependencies } from "../types.js";

const credentialRouteContextCache = new WeakMap<object, CredentialRouteContext>();

export interface PendingOpenAiBrowserReauthTarget {
  readonly accountId: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
}

export interface CredentialRouteContext {
  readonly credentialStore: UiRouteDependencies["credentialStore"];
  readonly openAiOAuthManager: OpenAiOAuthManager;
  readonly factoryOAuthManager: FactoryOAuthManager;
  readonly pendingOpenAiBrowserReauthTargets: Map<string, PendingOpenAiBrowserReauthTarget>;
}

export interface CredentialHtmlReply {
  header: (name: string, value: string) => void;
  send: (value: unknown) => void;
}

export interface OAuthCallbackQueryRequest {
  readonly query: {
    readonly state?: string;
    readonly code?: string;
    readonly error?: string;
    readonly error_description?: string;
  };
}

export function createCredentialRouteContext(deps: UiRouteDependencies): CredentialRouteContext {
  const cacheKey = deps.credentialStore as object;
  const cached = credentialRouteContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const context: CredentialRouteContext = {
    credentialStore: deps.credentialStore,
    openAiOAuthManager: new OpenAiOAuthManager({
      allowHostRoutedCallbacks: deps.config.openaiOauthAllowHostRoutedCallbacks,
      oauthScopes: deps.config.openaiOauthScopes,
      clientId: deps.config.openaiOauthClientId,
      issuer: deps.config.openaiOauthIssuer,
      clientSecret: deps.config.openaiOauthClientSecret,
    }),
    factoryOAuthManager: new FactoryOAuthManager(),
    pendingOpenAiBrowserReauthTargets: new Map<string, PendingOpenAiBrowserReauthTarget>(),
  };

  credentialRouteContextCache.set(cacheKey, context);
  return context;
}

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function htmlSuccess(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html>
  <head>
    <title>Open Hax OAuth Success</title>
    <style>
      body { font-family: "IBM Plex Sans", "Fira Sans", sans-serif; background: radial-gradient(circle at top, #12313b 0%, #0b161c 60%); color: #e9f7fb; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .card { background: rgba(17, 33, 42, 0.86); border: 1px solid rgba(145, 212, 232, 0.35); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }
      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }
      p { margin: 0; color: #bce2ec; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Authorization Successful</h1>
      <p>${safe}</p>
    </section>
    <script>setTimeout(() => window.close(), 1500)</script>
  </body>
</html>`;
}

export function htmlError(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html>
  <head>
    <title>Open Hax OAuth Failed</title>
    <style>
      body { font-family: "IBM Plex Sans", "Fira Sans", sans-serif; background: radial-gradient(circle at top, #381613 0%, #1a0f0e 60%); color: #ffe8e4; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      .card { background: rgba(42, 18, 16, 0.9); border: 1px solid rgba(255, 158, 143, 0.4); padding: 28px; border-radius: 14px; width: min(560px, 90vw); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.33); }
      h1 { margin: 0 0 12px 0; font-size: 1.4rem; }
      p { margin: 0; color: #ffc6bb; }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>Authorization Failed</h1>
      <p>${safe}</p>
    </section>
  </body>
</html>`;
}

export function inferBaseUrl(request: {
  readonly protocol: string;
  readonly headers: Record<string, unknown>;
}): string | undefined {
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
    ? request.headers["x-forwarded-host"]
    : undefined;
  const host = typeof request.headers.host === "string" ? request.headers.host : forwardedHost;
  if (!host) {
    return undefined;
  }

  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"]
    : undefined;
  const protocol = forwardedProto ?? request.protocol;
  return `${protocol}://${host}`;
}

export function resolveOpenAiProbeEndpoint(config: UiRouteDependencies["config"]): {
  readonly openAiBaseUrl: string;
  readonly openAiResponsesPath: string;
} {
  const configuredBaseUrl = config.openaiBaseUrl.trim();
  const configuredResponsesPath = config.openaiResponsesPath.trim();
  const localBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/iu.test(configuredBaseUrl);

  return {
    openAiBaseUrl: localBaseUrl ? "https://chatgpt.com/backend-api" : configuredBaseUrl,
    openAiResponsesPath: configuredResponsesPath.includes("/codex/") ? configuredResponsesPath : "/codex/responses",
  };
}
