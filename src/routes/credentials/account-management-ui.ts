import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerCredentialAccountManagementUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string; readonly credentialValue?: string; readonly apiKey?: string };
  }>(resolveCredentialRoutePath("/credentials/api-key", options), async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string"
      ? request.body.providerId
      : deps.config.upstreamProviderId;
    const credentialValueRaw = typeof request.body?.credentialValue === "string"
      ? request.body.credentialValue
      : request.body?.apiKey;
    const apiKey = typeof credentialValueRaw === "string" ? credentialValueRaw.trim() : "";
    if (apiKey.length === 0) {
      reply.code(400).send({ error: "api_key_required" });
      return;
    }

    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : `${providerId}-${Date.now()}`;

    await ctx.credentialStore.upsertApiKeyAccount(providerId, accountId, apiKey);
    await deps.keyPool.warmup().catch(() => undefined);
    reply.code(201).send({ ok: true, providerId, accountId });
  });

  app.delete<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/account", options), async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";

    if (providerId.length === 0 || accountId.length === 0) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    if (!ctx.credentialStore.removeAccount) {
      reply.code(501).send({ error: "remove_account_not_supported" });
      return;
    }

    const removed = await ctx.credentialStore.removeAccount(providerId, accountId);
    if (!removed) {
      reply.code(404).send({ error: "account_not_found" });
      return;
    }

    await deps.keyPool.warmup().catch(() => undefined);
    app.log.info({ providerId, accountId }, "removed credential account");
    reply.send({ ok: true, providerId, accountId });
  });
}
