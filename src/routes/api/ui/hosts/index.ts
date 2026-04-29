import type { FastifyInstance } from "fastify";
import type { UiRouteDependencies } from "../../../types.js";
import {
  collectLocalHostDashboardSnapshot,
  fetchRemoteHostDashboardSnapshot,
  inferSelfHostDashboardTargetId,
  loadHostDashboardTargetsFromEnv,
  resolveHostDashboardTargetToken,
} from "../../../../lib/host-dashboard.js";
import {
  getResolvedAuth,
} from "../../../shared/ui-auth.js";

function authCanAccessHostDashboard(auth: ReturnType<typeof getResolvedAuth> | undefined): boolean {
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

function inferBaseUrl(request: {
  readonly headers: {
    readonly host?: string;
    readonly "x-forwarded-host"?: string;
    readonly "x-forwarded-proto"?: string;
    readonly protocol?: string;
  };
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
  const protocol = forwardedProto ?? request.headers.protocol;
  return `${protocol}://${host}`;
}

export async function registerHostDashboardRoutes(
  app: FastifyInstance,
  _deps: UiRouteDependencies,
): Promise<void> {
  const hostDashboardTargets = loadHostDashboardTargetsFromEnv(process.env);
  const hostDashboardDockerSocketPath = process.env.HOST_DASHBOARD_DOCKER_SOCKET_PATH?.trim() || undefined;
  const hostDashboardRuntimeRoot = process.env.HOST_DASHBOARD_RUNTIME_ROOT?.trim() || undefined;
  const hostDashboardRequestTimeoutMs = Math.max(5000, Math.min(60_000, Number(process.env.HOST_DASHBOARD_REQUEST_TIMEOUT_MS) || 10000));

  app.get("/api/ui/hosts/self", async (request, reply) => {
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

  app.get("/api/ui/hosts/overview", async (request, reply) => {
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
