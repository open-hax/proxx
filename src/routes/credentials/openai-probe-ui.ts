import type { FastifyInstance } from "fastify";

import { probeOpenAiAccount } from "../../lib/openai-quota.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveOpenAiProbeEndpoint } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOpenAiProbeUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/openai/probe", options), async (request, reply) => {
    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : "";

    if (accountId.length === 0) {
      reply.code(400).send({ error: "account_id_required" });
      return;
    }

    try {
      const probeEndpoint = resolveOpenAiProbeEndpoint(deps.config);
      const result = await probeOpenAiAccount(ctx.credentialStore, {
        providerId: deps.config.openaiProviderId,
        accountId,
        openAiBaseUrl: probeEndpoint.openAiBaseUrl,
        openAiResponsesPath: probeEndpoint.openAiResponsesPath,
        logger: app.log,
      });

      reply.send(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusCode = detail.startsWith("OpenAI account not found:") ? 404 : 500;
      reply.code(statusCode).send({ error: statusCode === 404 ? "account_not_found" : "openai_probe_failed", detail });
    }
  });
}
