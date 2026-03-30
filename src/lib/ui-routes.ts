import type { FastifyInstance } from "fastify";

import type { FederationBridgeRelay } from "./federation/bridge-relay.js";
import { registerCredentialUiRoutes } from "../routes/credentials/index.js";
import { registerFederationUiRoutes } from "../routes/federation/index.js";
import { registerObservabilityRoutes } from "../routes/observability/index.js";
import { createSessionUiRouteContext, registerSessionUiRoutes } from "../routes/sessions/index.js";
import { registerSettingsUiRoutes } from "../routes/settings/index.js";
import type { UiRouteDependencies } from "../routes/types.js";
import { registerEventRoutes } from "../routes/api/ui/events/index.js";
import { registerHostDashboardRoutes } from "../routes/api/ui/hosts/index.js";
import { registerStaticAssetRoutes } from "../routes/api/ui/assets.js";
import { registerWebSocketRoutes } from "../routes/api/ui/ws.js";

export function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }
  return fallback;
}

export async function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<FederationBridgeRelay> {
  app.addHook("onRequest", async (request, reply) => {
    const rawPath = request.raw.url?.split("?")[0] ?? request.url.split("?")[0];
    if (rawPath.startsWith("/api/ui/")) {
      reply.header("Deprecation", "true");
      reply.header("Link", `</api/v1${rawPath.slice("/api/ui".length)}>; rel="successor-version"`);
    }
  });

  const sessionContext = createSessionUiRouteContext({
    ollamaBaseUrl: deps.config.ollamaBaseUrl,
    warn: (error) => {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to warm semantic session index from stored sessions",
      );
    },
  });

  const { bridgeRelay } = await registerWebSocketRoutes(app, deps);

  await registerSettingsUiRoutes(app, deps);
  await registerSessionUiRoutes(app, deps, sessionContext);
  await registerFederationUiRoutes(app, deps, {
    bridgeRelay,
    federationRequestTimeoutMs: toSafeLimit(process.env.FEDERATION_REQUEST_TIMEOUT_MS, 5000, 60_000),
  });
  await registerObservabilityRoutes(app, deps);
  await registerHostDashboardRoutes(app, deps);
  await registerCredentialUiRoutes(app, deps);
  await registerEventRoutes(app, deps);
  await registerStaticAssetRoutes(app);

  return bridgeRelay;
}
