import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

import {
  buildProviderModelAnalytics,
  buildUsageOverview,
  resolveUsageScopeFromAuth,
  toUsageWindow,
} from "../api/ui/analytics/usage.js";
import { loadMcpSeeds, getToolSeedForModel, type McpServerSeed } from "../../lib/tool-mcp-seed.js";
import { normalizeTenantId } from "../../lib/tenant-api-key.js";
import { authCanViewTenant, getResolvedAuth } from "../shared/ui-auth.js";
import type { UiRouteDependencies } from "../types.js";
import { API_V1_OBSERVABILITY_ROUTE_PREFIX, resolveObservabilityRoutePath, type ObservabilityRouteOptions } from "./prefix.js";

function toSafeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.floor(value), max));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(parsed, max));
    }
  }

  return fallback;
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await import("node:fs/promises").then(({ access }) => access(candidate));
      return candidate;
    } catch {
      // continue
    }
  }

  return undefined;
}

let mcpSeedCache: { readonly loadedAt: number; readonly seeds: readonly McpServerSeed[] } | undefined;

async function loadCachedMcpSeeds(): Promise<readonly McpServerSeed[]> {
  const now = Date.now();
  if (mcpSeedCache && now - mcpSeedCache.loadedAt < 30_000) {
    return mcpSeedCache.seeds;
  }

  const ecosystemsDir = await firstExistingPath([
    resolve(process.cwd(), "../../ecosystems"),
    resolve(process.cwd(), "../ecosystems"),
    resolve(process.cwd(), "ecosystems"),
  ]);

  if (!ecosystemsDir) {
    mcpSeedCache = { loadedAt: now, seeds: [] };
    return [];
  }

  const seeds = await loadMcpSeeds(ecosystemsDir).catch(() => []);
  mcpSeedCache = {
    loadedAt: now,
    seeds,
  };
  return seeds;
}

export async function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
  options?: ObservabilityRouteOptions,
): Promise<void> {
  app.get<{
    Querystring: {
      readonly providerId?: string;
      readonly accountId?: string;
      readonly tenantId?: string;
      readonly issuer?: string;
      readonly keyId?: string;
      readonly limit?: string;
      readonly before?: string;
    };
  }>(resolveObservabilityRoutePath("/request-logs", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    let tenantId = typeof request.query.tenantId === "string" && request.query.tenantId.trim().length > 0
      ? normalizeTenantId(request.query.tenantId)
      : undefined;
    let keyId = typeof request.query.keyId === "string" && request.query.keyId.trim().length > 0
      ? request.query.keyId.trim()
      : undefined;

    if (auth.kind !== "legacy_admin" && auth.kind !== "unauthenticated") {
      if (tenantId) {
        if (!authCanViewTenant(auth, tenantId)) {
          reply.code(403).send({ error: "forbidden" });
          return;
        }
      } else if (auth.tenantId) {
        tenantId = auth.tenantId;
      }

      if (auth.kind === "tenant_api_key") {
        if (keyId && auth.keyId && keyId !== auth.keyId) {
          reply.code(403).send({ error: "forbidden" });
          return;
        }
        keyId = auth.keyId;
      }
    }

    const entryFilters = {
      providerId: request.query.providerId,
      accountId: request.query.accountId,
      tenantId,
      issuer: typeof request.query.issuer === "string" && request.query.issuer.trim().length > 0
        ? request.query.issuer.trim()
        : undefined,
      keyId,
      limit: toSafeLimit(request.query.limit, 200, 2000),
      before: typeof request.query.before === "string" && request.query.before.length > 0
        ? request.query.before
        : undefined,
    };

    const entries = deps.sqlRequestUsageStore
      ? await deps.sqlRequestUsageStore.listEntries(entryFilters)
      : deps.requestLogStore.list(entryFilters);

    reply.send({
      entries: entries.map((entry) => ({
        ...entry,
        decodeTps: entry.tps,
      })),
    });
  });

  app.get<{
    Querystring: { readonly sort?: string; readonly window?: string; readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  }>(resolveObservabilityRoutePath("/dashboard/overview", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const scope = await resolveUsageScopeFromAuth({
      auth,
      tenantId: request.query.tenantId,
      issuer: request.query.issuer,
      keyId: request.query.keyId,
    });
    if ("error" in scope) {
      reply.code(scope.statusCode).send({ error: scope.error });
      return;
    }

    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const overview = await buildUsageOverview(
      deps.requestLogStore,
      deps.keyPool,
      deps.credentialStore,
      sort,
      window,
      scope,
      deps.sqlRequestUsageStore,
    );
    reply.send(overview);
  });

  app.get<{
    Querystring: { readonly sort?: string; readonly window?: string; readonly tenantId?: string; readonly issuer?: string; readonly keyId?: string };
  }>(resolveObservabilityRoutePath("/analytics/provider-model", options), async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!auth) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const scope = await resolveUsageScopeFromAuth({
      auth,
      tenantId: request.query.tenantId,
      issuer: request.query.issuer,
      keyId: request.query.keyId,
    });
    if ("error" in scope) {
      reply.code(scope.statusCode).send({ error: scope.error });
      return;
    }

    const sort = typeof request.query.sort === "string" ? request.query.sort : undefined;
    const window = toUsageWindow(request.query.window);
    const analytics = await buildProviderModelAnalytics(
      deps.requestLogStore,
      window,
      sort,
      scope,
      deps.sqlRequestUsageStore,
    );
    reply.send(analytics);
  });

  app.get<{
    Querystring: { readonly model?: string };
  }>(resolveObservabilityRoutePath("/tools", options), async (request, reply) => {
    const model = typeof request.query.model === "string" && request.query.model.trim().length > 0
      ? request.query.model.trim()
      : "gpt-5.3-codex";

    reply.send({
      model,
      tools: getToolSeedForModel(model),
    });
  });

  app.get(resolveObservabilityRoutePath("/mcp-servers", options), async (_request, reply) => {
    const seeds = await loadCachedMcpSeeds();
    reply.send({
      count: seeds.length,
      servers: seeds,
    });
  });
}

export async function registerCanonicalObservabilityRoutes(
  app: FastifyInstance,
  deps: UiRouteDependencies,
): Promise<void> {
  await registerObservabilityRoutes(app, deps, { prefix: API_V1_OBSERVABILITY_ROUTE_PREFIX });
}