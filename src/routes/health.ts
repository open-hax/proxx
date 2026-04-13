import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { toErrorMessage } from "../lib/provider-utils.js";

export function registerHealthRoutes(deps: AppDeps, app: FastifyInstance): void {
  app.get("/health", async () => {
    let keyPoolStatus: unknown;
    let keyPoolProviders: unknown;
    try {
      const status = await deps.keyPool.getStatus(deps.config.upstreamProviderId);
      keyPoolStatus = {
        providerId: status.providerId,
        authType: status.authType,
        totalKeys: status.totalAccounts,
        availableKeys: status.availableAccounts,
        cooldownKeys: status.cooldownAccounts,
        nextReadyInMs: status.nextReadyInMs
      };

      const allStatuses = await deps.keyPool.getAllStatuses();
      keyPoolProviders = Object.fromEntries(
        Object.entries(allStatuses).map(([providerId, providerStatus]) => [
          providerId,
          {
            providerId: providerStatus.providerId,
            authType: providerStatus.authType,
            totalAccounts: providerStatus.totalAccounts,
            availableAccounts: providerStatus.availableAccounts,
            cooldownAccounts: providerStatus.cooldownAccounts,
            nextReadyInMs: providerStatus.nextReadyInMs
          }
        ])
      );
    } catch (error) {
      keyPoolStatus = { error: toErrorMessage(error) };
      keyPoolProviders = {};
      return {
        ok: false,
        service: "open-hax-openai-proxy",
        authMode: deps.config.proxyAuthToken ? "token" : "unauthenticated",
        keyPool: keyPoolStatus,
        keyPoolProviders
      };
    }

    return {
      ok: true,
      service: "open-hax-openai-proxy",
      authMode: deps.config.proxyAuthToken ? "token" : "unauthenticated",
      keyPool: keyPoolStatus,
      keyPoolProviders
    };
  });
}
