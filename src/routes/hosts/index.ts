import type { FastifyInstance } from "fastify";

import {
  collectLocalHostDashboardSnapshot,
  fetchRemoteHostDashboardSnapshot,
  inferSelfHostDashboardTargetId,
  loadHostDashboardTargetsFromEnv,
  resolveHostDashboardTargetToken,
} from "../../lib/host-dashboard.js";
import type { ResolvedRequestAuth } from "../../lib/request-auth.js";
import { getResolvedAuth } from "../shared/ui-auth.js";
import type { UiRouteDependencies } from "../types.js";

function inferBaseUrl(request: {
  readonly protocol: string;
  readonly headers: Record<string, unknown>;
}): string | undefined {
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string"
    ? request.headers["x-forwarded-host"]
    : undefined;
  const host = typeof request.headers.host === "string" ? request.headers.host : forwardedHost;
  if (!host) {
    return undefined;
  }

  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string"
    ? request.headers["x-forwarded-proto"]
    : undefined;
  const protocol = forwardedProto ?? request.protocol;
  return `${protocol}://${host}`;
}

function authCanAccessHostDashboard(auth: ResolvedRequestAuth | undefined): boolean {
  if (!auth) {
    return false;
  }

  if (auth.kind === "legacy_admin") {
    return true;
  }

  if (auth.kind === "ui_session") {
    return auth.role === "owner" || auth.role === "admin";
  }

  return false;
}

function resolveHostDashboardTimeoutMs(): number {
  const raw = process.env.HOST_DASHBOARD_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return 5000;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(5000, Math.min(parsed, 60_000)) : 5000;
}

export async function registerHostRoutes(
  app: FastifyInstance,
  _deps: UiRouteDependencies,
): Promise<void> {
  const hostDashboardTargets = loadHostDashboardTargetsFromEnv(process.env);
  const hostDashboardDockerSocketPath = process.env.HOST_DASHBOARD_DOCKER_SOCKET_PATH?.trim() || undefined;
  const hostDashboardRuntimeRoot = process.env.HOST_DASHBOARD_RUNTIME_ROOT?.trim() || undefined;
  const hostDashboardRequestTimeoutMs = resolveHostDashboardTimeoutMs();

  app.get("/api/v1/hosts/self", async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanAccessHostDashboard(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const requestBaseUrl = inferBaseUrl(request);
    const selfTargetId = inferSelfHostDashboardTargetId({
      targets: hostDashboardTargets,
      explicitSelfId: process.env.HOST_DASHBOARD_SELF_ID,
      requestBaseUrl,
      requestHost: typeof request.headers.host === "string" ? request.headers.host : undefined,
    });
    const selfTarget = hostDashboardTargets.find((target) => target.id === selfTargetId) ?? hostDashboardTargets[0];
    if (!selfTarget) {
      reply.code(500).send({ error: "host_dashboard_targets_not_configured" });
      return;
    }

    const snapshot = await collectLocalHostDashboardSnapshot({
      target: selfTarget,
      dockerSocketPath: hostDashboardDockerSocketPath,
      runtimeRoot: hostDashboardRuntimeRoot,
    });
    reply.send(snapshot);
  });

  app.get("/api/v1/hosts/overview", async (request, reply) => {
    const auth = getResolvedAuth(request);
    if (!authCanAccessHostDashboard(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const requestBaseUrl = inferBaseUrl(request);
    const selfTargetId = inferSelfHostDashboardTargetId({
      targets: hostDashboardTargets,
      explicitSelfId: process.env.HOST_DASHBOARD_SELF_ID,
      requestBaseUrl,
      requestHost: typeof request.headers.host === "string" ? request.headers.host : undefined,
    });

    const hosts = await Promise.all(hostDashboardTargets.map(async (target) => {
      if (selfTargetId && target.id === selfTargetId) {
        return collectLocalHostDashboardSnapshot({
          target,
          dockerSocketPath: hostDashboardDockerSocketPath,
          runtimeRoot: hostDashboardRuntimeRoot,
        });
      }

      return fetchRemoteHostDashboardSnapshot({
        target,
        authToken: resolveHostDashboardTargetToken(target, process.env),
        timeoutMs: hostDashboardRequestTimeoutMs,
      });
    }));

    reply.send({
      generatedAt: new Date().toISOString(),
      selfTargetId: selfTargetId ?? null,
      hosts,
    });
  });
}
