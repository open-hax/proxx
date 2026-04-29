import type { FastifyInstance } from "fastify";

import { probeOllamaCloudAccount } from "../../lib/ollama-cloud-probe.js";
import type { UiRouteDependencies } from "../types.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerOllamaCloudProbeUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.post<{
    Body: { readonly accountId?: string };
  }>(resolveCredentialRoutePath("/credentials/ollama-cloud/probe", options), async (request, reply) => {
    const accountId = typeof request.body?.accountId === "string" && request.body.accountId.trim().length > 0
      ? request.body.accountId.trim()
      : "";

    if (accountId.length === 0) {
      reply.code(400).send({ error: "account_id_required" });
      return;
    }

    try {
      const baseUrl = deps.config.upstreamProviderBaseUrls["ollama-cloud"]?.trim() || "https://ollama.com";
      const result = await probeOllamaCloudAccount(ctx.credentialStore, {
        providerId: "ollama-cloud",
        accountId,
        baseUrl,
      });

      reply.send(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const statusCode = detail.startsWith("Ollama Cloud account not found:") ? 404 : 500;
      reply.code(statusCode).send({ error: statusCode === 404 ? "account_not_found" : "ollama_cloud_probe_failed", detail });
    }
  });
}