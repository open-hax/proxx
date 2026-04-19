import type { FastifyInstance } from "fastify";

import { fetchOpenAiQuotaSnapshots } from "../../lib/openai-quota.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOpenAiQuotaUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.get<{
    Querystring: { readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/quota", options), async (request, reply) => {
    const overview = await fetchOpenAiQuotaSnapshots(ctx.credentialStore, {
      providerId: deps.config.openaiProviderId,
      accountId: typeof request.query.accountId === "string" && request.query.accountId.trim().length > 0
        ? request.query.accountId.trim()
        : undefined,
      logger: app.log,
    });

    reply.send(overview);
  });
}
