import type { FastifyInstance } from "fastify";

import { openAiReauthIdentityMatches } from "../../lib/account-identity.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext, CredentialHtmlReply, OAuthCallbackQueryRequest, PendingOpenAiBrowserReauthTarget } from "./context.js";
import { htmlError, htmlSuccess, inferBaseUrl } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOpenAiBrowserOAuthUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly redirectBaseUrl?: string; readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/oauth/browser/start", options), async (request, reply) => {
    const requestBaseUrl = inferBaseUrl(request);
    const redirectBaseUrl = typeof request.body?.redirectBaseUrl === "string" && request.body.redirectBaseUrl.trim().length > 0
      ? request.body.redirectBaseUrl.trim()
      : requestBaseUrl;
    const requestedAccountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";

    if (!redirectBaseUrl) {
      reply.code(400).send({ error: "redirect_base_url_required" });
      return;
    }

    let pendingReauthTarget: PendingOpenAiBrowserReauthTarget | undefined;
    if (requestedAccountId.length > 0) {
      const providers = await ctx.credentialStore.listProviders(false);
      const openAiProvider = providers.find((provider) => provider.id === deps.config.openaiProviderId);
      const targetAccount = openAiProvider?.accounts.find((account) => account.id === requestedAccountId);

      if (!targetAccount) {
        reply.code(404).send({ error: "account_not_found" });
        return;
      }

      pendingReauthTarget = {
        accountId: targetAccount.id,
        chatgptAccountId: targetAccount.chatgptAccountId,
        email: targetAccount.email,
        subject: targetAccount.subject,
      };
    }

    const payload = await ctx.openAiOAuthManager.startBrowserFlow(redirectBaseUrl);
    if (pendingReauthTarget) {
      ctx.pendingOpenAiBrowserReauthTargets.set(payload.state, pendingReauthTarget);
    }

    reply.send(payload);
  });

  const handleOpenAiBrowserCallback = async (
    request: OAuthCallbackQueryRequest,
    reply: CredentialHtmlReply,
  ) => {
    const error = request.query.error;
    if (typeof error === "string" && error.length > 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(request.query.error_description ?? error));
      return;
    }

    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";

    if (state.length === 0 || code.length === 0) {
      reply.header("content-type", "text/html");
      reply.send(htmlError("Missing OAuth callback state or code."));
      return;
    }

    try {
      const pendingReauthTarget = ctx.pendingOpenAiBrowserReauthTargets.get(state);
      ctx.pendingOpenAiBrowserReauthTargets.delete(state);
      const tokens = await ctx.openAiOAuthManager.completeBrowserFlow(state, code);
      await ctx.credentialStore.upsertOAuthAccount(
        deps.config.openaiProviderId,
        tokens.accountId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.chatgptAccountId,
        tokens.email,
        tokens.subject,
        tokens.planType,
      );

      let replacedAccountId: string | undefined;
      let retainedOriginalAccount = false;
      if (pendingReauthTarget && pendingReauthTarget.accountId !== tokens.accountId && ctx.credentialStore.removeAccount) {
        if (openAiReauthIdentityMatches(pendingReauthTarget, tokens)) {
          const removed = await ctx.credentialStore.removeAccount(deps.config.openaiProviderId, pendingReauthTarget.accountId);
          if (removed) {
            replacedAccountId = pendingReauthTarget.accountId;
          }
        } else {
          retainedOriginalAccount = true;
        }
      }

      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: deps.config.openaiProviderId,
        accountId: tokens.accountId,
        chatgptAccountId: tokens.chatgptAccountId,
      }, "saved OpenAI OAuth account from browser flow");

      reply.header("content-type", "text/html");
      const label = tokens.email ?? tokens.chatgptAccountId ?? tokens.accountId;
      const message = replacedAccountId
        ? `Reauthenticated OpenAI account ${label} and replaced ${replacedAccountId}.`
        : retainedOriginalAccount
          ? `Saved OpenAI OAuth account ${label}. Original account was kept because the completed sign-in resolved to a different identity.`
          : `Saved OpenAI OAuth account ${label}.`;
      reply.send(htmlSuccess(message));
    } catch (oauthError) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(oauthError instanceof Error ? oauthError.message : String(oauthError)));
    }
  };

  app.get<{
    Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/oauth/browser/callback", options), handleOpenAiBrowserCallback);

  if (options?.registerSharedAuthCallbacks !== false) {
    app.get<{
      Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
    }>("/auth/callback", handleOpenAiBrowserCallback);
  }
}
