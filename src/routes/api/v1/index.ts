import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../types.js";
import type { FederationBridgeRelay } from "../../../lib/federation/bridge-relay.js";

export interface ApiV1RouteDependencies extends UiRouteDependencies {
  serverUrl?: string;
  bridgeRelay?: FederationBridgeRelay;
}

type ApiV1EndpointStatus = "planned" | "implemented";

interface ApiV1EndpointDescriptor {
  readonly path: string;
  readonly legacyPath: string;
  readonly status: ApiV1EndpointStatus;
  readonly description: string;
}

const API_V1_ENDPOINTS = {
  credentials: {
    path: "/api/v1/credentials",
    legacyPath: "/api/ui/credentials",
    status: "implemented",
    description: "Credential management endpoints migrating from the legacy UI surface.",
  },
  federation: {
    path: "/api/v1/federation",
    legacyPath: "/api/ui/federation",
    status: "planned",
    description: "Federation control and synchronization endpoints migrating from the legacy UI surface.",
  },
  sessions: {
    path: "/api/v1/sessions",
    legacyPath: "/api/ui/sessions",
    status: "implemented",
    description: "Session and search endpoints migrating from the legacy UI surface.",
  },
  settings: {
    path: "/api/v1/settings",
    legacyPath: "/api/ui/settings",
    status: "implemented",
    description: "Tenant and proxy settings endpoints migrating from the legacy UI surface.",
  },
  hosts: {
    path: "/api/v1/hosts",
    legacyPath: "/api/ui/hosts",
    status: "implemented",
    description: "Host inventory and host overview endpoints migrating from the legacy UI surface.",
  },
  events: {
    path: "/api/v1/events",
    legacyPath: "/api/ui/events",
    status: "implemented",
    description: "Event store query and tag endpoints migrating from the legacy UI surface.",
  },
  observability: {
    path: "/api/v1/dashboard",
    legacyPath: "/api/ui/dashboard",
    status: "implemented",
    description: "Dashboard, analytics, request-log, tool, and MCP seed endpoints migrating from the legacy UI surface.",
  },
  mcp: {
    path: "/api/v1/mcp",
    legacyPath: "/api/ui/mcp-servers",
    status: "planned",
    description: "MCP discovery endpoints migrating from the legacy UI surface.",
  },
} as const satisfies Record<string, ApiV1EndpointDescriptor>;

function countEndpointsWithStatus(status: ApiV1EndpointStatus): number {
  return Object.values(API_V1_ENDPOINTS).filter((endpoint) => endpoint.status === status).length;
}

export async function registerApiV1Routes(
  app: FastifyInstance,
  deps: ApiV1RouteDependencies
): Promise<void> {
  const registerRoutes = [
    (await import("../../federation/index.js")).registerFederationRoutes,
    (await import("../../settings/index.js")).registerSettingsRoutes,
    (await import("../../sessions/index.js")).registerSessionRoutes,
    (await import("../../credentials/index.js")).registerCredentialsRoutes,
    (await import("../../hosts/index.js")).registerHostRoutes,
    (await import("../../events/index.js")).registerEventRoutes,
    (await import("../../mcp/index.js")).registerMcpRoutes,
    (await import("../../observability/index.js")).registerCanonicalObservabilityRoutes,
  ] as const;

  for (const registerRoute of registerRoutes) {
    await registerRoute(app, deps);
  }

  app.get("/api/v1", async () => ({
    version: "1.0.0",
    migration: {
      legacyPrefix: "/api/ui",
      targetPrefix: "/api/v1",
      strategy: "planned_to_implemented",
      deprecationRule: "legacy routes are deprecated only after the corresponding /api/v1 endpoint is implemented",
    },
    summary: {
      planned: countEndpointsWithStatus("planned"),
      implemented: countEndpointsWithStatus("implemented"),
    },
    endpoints: API_V1_ENDPOINTS,
    documentation: {
      path: "/api/v1/openapi.json",
      status: "implemented",
    },
  }));
}
