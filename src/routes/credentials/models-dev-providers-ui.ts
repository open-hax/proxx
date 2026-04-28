import type { FastifyInstance } from "fastify";

import type { UiRouteDependencies } from "../types.js";
import { getModelsDevProviderDescriptors } from "../../lib/models-dev.js";
import type { CredentialRouteContext } from "./context.js";
import { resolveCredentialRoutePath, type CredentialRouteOptions } from "./prefix.js";

export async function registerModelsDevProvidersUiRoute(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  _ctx: CredentialRouteContext,
  options?: CredentialRouteOptions,
): Promise<void> {
  app.get(resolveCredentialRoutePath("/credentials/providers/models-dev", options), async (_request, reply) => {
    const providers = getModelsDevProviderDescriptors();
    const keyPoolStatuses = await deps.keyPool.getAllStatuses().catch(() => ({} as Record<string, { readonly totalAccounts?: number }>));

    reply.send({
      providers: providers.map((provider) => ({
        ...provider,
        hasCredentials: (keyPoolStatuses[provider.providerId]?.totalAccounts ?? 0) > 0,
      })),
    });
  });
}
