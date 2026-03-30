import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOpenAiRefreshUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  _ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/oauth/refresh", options), async (request, reply) => {
    if (!deps.refreshOpenAiOauthAccounts) {
      reply.code(501).send({ error: "oauth_refresh_not_supported" });
      return;
    }

    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : undefined;

    const result = await deps.refreshOpenAiOauthAccounts(accountId);
    reply.send(result);
  });
}
