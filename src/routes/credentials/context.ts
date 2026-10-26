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

/**
 * The OAuth managers and pending re-authentication targets are shared by every
 * registration of the credential routes over one credential store (the prefixed
 * routes and the unprefixed /auth callbacks complete the same flows), so they
 * are built once per store. The routes themselves are CLJS
 * (`proxx.runtime.routes.credentials`).
 */
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
