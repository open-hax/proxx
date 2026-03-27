import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerFactoryDeviceOAuthUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post(resolveCredentialRoutePath("/credentials/factory/oauth/device/start", options), async (_request, reply) => {
    try {
      const payload = await ctx.factoryOAuthManager.startDeviceFlow();
      reply.send(payload);
    } catch (error) {
      reply.code(502).send({ error: "device_flow_start_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly deviceAuthId?: string };
  }>(resolveCredentialRoutePath("/credentials/factory/oauth/device/poll", options), async (request, reply) => {
    const deviceAuthId = typeof request.body?.deviceAuthId === "string" ? request.body.deviceAuthId : "";

    if (deviceAuthId.length === 0) {
      reply.code(400).send({ error: "device_auth_id_required" });
      return;
    }

    const result = await ctx.factoryOAuthManager.pollDeviceFlow(deviceAuthId);
    if (result.state === "authorized") {
      await ctx.credentialStore.upsertOAuthAccount(
        "factory",
        result.tokens.accountId,
        result.tokens.accessToken,
        result.tokens.refreshToken,
        result.tokens.expiresAt,
        undefined,
        result.tokens.email,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: "factory",
        accountId: result.tokens.accountId,
        email: result.tokens.email,
      }, "saved Factory OAuth account from device flow");
    }

    reply.send(result);
  });
}
