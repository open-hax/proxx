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
      : `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await ctx.credentialStore.upsertApiKeyAccount(providerId, accountId, apiKey);
    await deps.keyPool.warmup().catch(() => undefined);
    reply.code(201).send({ ok: true, providerId, accountId });
  });

  app.post<{
    Body: { readonly providerId?: string; readonly baseUrl?: string; readonly accountId?: string; readonly credentialValue?: string; readonly apiKey?: string };
  }>(resolveCredentialRoutePath("/credentials/provider", options), async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string"
      ? request.body.providerId.trim()
      : "";
    const baseUrl = typeof request.body?.baseUrl === "string"
      ? request.body.baseUrl.trim()
      : "";

    if (providerId.length === 0) {
      reply.code(400).send({ error: "provider_id_required" });
      return;
    }

    if (baseUrl.length === 0) {
      reply.code(400).send({ error: "base_url_required" });
      return;
    }

    if (!deps.sqlCredentialStore) {
      reply.code(500).send({ error: "sql_credential_store_not_available" });
      return;
    }

    await deps.sqlCredentialStore.upsertProviderWithBaseUrl(providerId, "api_key", baseUrl);

    const credentialValueRaw = typeof request.body?.credentialValue === "string"
      ? request.body.credentialValue
      : request.body?.apiKey;
    const apiKey = typeof credentialValueRaw === "string" ? credentialValueRaw.trim() : "";

    if (apiKey.length > 0) {
      const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
        ? request.body.accountId.trim()
        : `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await deps.sqlCredentialStore.upsertApiKeyAccount(providerId, accountId, apiKey);
    }

    await deps.keyPool.warmup().catch(() => undefined);
    reply.code(201).send({ ok: true, providerId, baseUrl });
  });

  app.get<{
    Params: { providerId: string };
  }>(resolveCredentialRoutePath("/credentials/provider/:providerId", options), async (request, reply) => {
    const { providerId } = request.params;

    if (!deps.sqlCredentialStore) {
      reply.code(500).send({ error: "sql_credential_store_not_available" });
      return;
    }

    const provider = await deps.sqlCredentialStore.getProviderById(providerId);
    if (!provider) {
      reply.code(404).send({ error: "provider_not_found" });
      return;
    }

    reply.send({
      providerId: provider.id,
      authType: provider.authType,
      baseUrl: provider.baseUrl,
    });
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

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/account/disable", options), async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";

    if (providerId.length === 0 || accountId.length === 0) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    deps.keyPool.disableAccount(providerId, accountId);
    app.log.info({ providerId, accountId }, "disabled credential account");
    reply.send({ ok: true, providerId, accountId, disabled: true });
  });

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/account/enable", options), async (request, reply) => {
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";

    if (providerId.length === 0 || accountId.length === 0) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    deps.keyPool.enableAccount(providerId, accountId);
    app.log.info({ providerId, accountId }, "enabled credential account");
    reply.send({ ok: true, providerId, accountId, disabled: false });
  });

  app.get(resolveCredentialRoutePath("/credentials/accounts/disabled", options), async (_request, reply) => {
    const disabledAccounts = deps.keyPool.getDisabledAccounts();
    reply.send({ disabledAccounts });
  });
}
