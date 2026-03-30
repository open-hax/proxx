import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOpenAiDeviceOAuthUiRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post(resolveCredentialRoutePath("/credentials/openai/oauth/device/start", options), async (_request, reply) => {
    try {
      const payload = await ctx.openAiOAuthManager.startDeviceFlow();
      reply.send(payload);
    } catch (error) {
      reply.code(502).send({ error: "device_flow_start_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Body: { readonly deviceAuthId?: string; readonly userCode?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/oauth/device/poll", options), async (request, reply) => {
    const deviceAuthId = typeof request.body?.deviceAuthId === "string" ? request.body.deviceAuthId : "";
    const userCode = typeof request.body?.userCode === "string" ? request.body.userCode : "";

    if (deviceAuthId.length === 0 || userCode.length === 0) {
      reply.code(400).send({ error: "device_auth_id_and_user_code_required" });
      return;
    }

    const result = await ctx.openAiOAuthManager.pollDeviceFlow(deviceAuthId, userCode);
    if (result.state === "authorized") {
      await ctx.credentialStore.upsertOAuthAccount(
        deps.config.openaiProviderId,
        result.tokens.accountId,
        result.tokens.accessToken,
        result.tokens.refreshToken,
        result.tokens.expiresAt,
        result.tokens.chatgptAccountId,
        result.tokens.email,
        result.tokens.subject,
        result.tokens.planType,
      );
      await deps.keyPool.warmup().catch(() => undefined);
      app.log.info({
        providerId: deps.config.openaiProviderId,
        accountId: result.tokens.accountId,
        chatgptAccountId: result.tokens.chatgptAccountId,
      }, "saved OpenAI OAuth account from device flow");
    }

    reply.send(result);
  });
}
