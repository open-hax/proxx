import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { htmlError, htmlSuccess, inferBaseUrl } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerFactoryBrowserOAuthUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly redirectBaseUrl?: string };
  }>(resolveCredentialRoutePath("/credentials/factory/oauth/browser/start", options), async (request, reply) => {
    const requestBaseUrl = inferBaseUrl(request);
    const redirectBaseUrl = typeof request.body?.redirectBaseUrl === "string" && request.body.redirectBaseUrl.trim().length > 0
      ? request.body.redirectBaseUrl.trim()
      : requestBaseUrl;

    if (!redirectBaseUrl) {
      reply.code(400).send({ error: "redirect_base_url_required" });
      return;
    }

    const redirectUri = new URL("/auth/factory/callback", redirectBaseUrl).toString();
    const payload = ctx.factoryOAuthManager.startBrowserFlow(redirectUri);
    reply.send(payload);
  });

  if (options?.registerSharedAuthCallbacks !== false) {
    app.get<{
      Querystring: { readonly state?: string; readonly code?: string; readonly error?: string; readonly error_description?: string };
    }>("/auth/factory/callback", async (request, reply) => {
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
      const tokens = await ctx.factoryOAuthManager.completeBrowserFlow(state, code);
      await ctx.credentialStore.upsertOAuthAccount(
        "factory",
        tokens.accountId,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        undefined,
        tokens.email,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: "factory",
        accountId: tokens.accountId,
        email: tokens.email,
      }, "saved Factory OAuth account from browser flow");

      reply.header("content-type", "text/html");
      reply.send(htmlSuccess(`Saved Factory.ai OAuth account${tokens.email ? ` (${tokens.email})` : ""}.`));
    } catch (oauthError) {
      reply.header("content-type", "text/html");
      reply.send(htmlError(oauthError instanceof Error ? oauthError.message : String(oauthError)));
    }
    });
  }
}
