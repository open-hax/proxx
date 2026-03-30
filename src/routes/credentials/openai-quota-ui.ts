import type { FastifyInstance } from "fastify";

import { fetchOpenAiQuotaSnapshots } from "../../lib/openai-quota.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";
import { listVisibleOpenAiAccounts } from "./visible-accounts.js";

export async function registerOpenAiQuotaUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.get<{
    Querystring: { readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/quota", options), async (request, reply) => {
    const requestedAccountId = typeof request.query.accountId === "string" && request.query.accountId.trim().length > 0
      ? request.query.accountId.trim()
      : undefined;
    const visibleOpenAiAccounts = await listVisibleOpenAiAccounts({
      credentialStore: ctx.credentialStore,
      keyPool: deps.keyPool,
      providerId: deps.config.openaiProviderId,
      revealSecrets: true,
    });
    const visibleAccountIds = new Set(visibleOpenAiAccounts.map((account) => account.id));

    const overview = await fetchOpenAiQuotaSnapshots(ctx.credentialStore, {
      providerId: deps.config.openaiProviderId,
      accountId: requestedAccountId,
      accounts: visibleOpenAiAccounts,
      logger: app.log,
    });

    reply.send({
      ...overview,
      accounts: overview.accounts.filter((account) => visibleAccountIds.has(account.accountId)),
    });
  });
}
