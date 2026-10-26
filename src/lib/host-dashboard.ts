import { kernels } from "./cljs-kernels.js";

/**
 * Host dashboard aggregation. Parsing (fleet targets, Caddy routes, Docker rows)
 * and snapshot assembly are pure CLJS (`proxx.dashboard.host`); the Docker
 * socket, Caddyfile reads and the remote fetch are `proxx.runtime.host-dashboard`.
 */
export interface HostDashboardTarget {
  readonly id: string;
  readonly label: string;
  readonly baseUrl?: string;
  readonly publicHost?: string;
  readonly authToken?: string;
  readonly authTokenEnv?: string;
  readonly notes?: string;
}

export interface HostDashboardContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: readonly string[];
}

export interface HostDashboardRouteSummary {
  readonly host: string;
  readonly matcher?: string;
  readonly matchPaths: readonly string[];
  readonly upstreams: readonly string[];
}

export interface HostDashboardSummary {
  readonly containerCount: number;
  readonly runningCount: number;
  readonly healthyCount: number;
  readonly routeCount: number;
}

export interface HostDashboardSnapshot {
  readonly id: string;
  readonly label: string;
  readonly source: "local" | "remote";
  readonly fetchedAt: string;
  readonly reachable: boolean;
  readonly baseUrl?: string;
  readonly publicHost?: string;
  readonly notes?: string;
  readonly errors: readonly string[];
  readonly containers: readonly HostDashboardContainerSummary[];
  readonly routes: readonly HostDashboardRouteSummary[];
  readonly summary: HostDashboardSummary;
}

export function loadHostDashboardTargetsFromEnv(env: NodeJS.ProcessEnv): readonly HostDashboardTarget[] {
  return kernels.loadHostDashboardTargetsFromEnv(env);
}

export function resolveHostDashboardTargetToken(target: HostDashboardTarget, env: NodeJS.ProcessEnv): string | undefined {
  return kernels.resolveHostDashboardTargetToken(target, env);
}

export function inferSelfHostDashboardTargetId(input: {
  readonly targets: readonly HostDashboardTarget[];
  readonly explicitSelfId?: string;
  readonly requestBaseUrl?: string;
  readonly requestHost?: string;
}): string | undefined {
  return kernels.inferSelfHostDashboardTargetId(input);
}

export function parseCaddyRoutes(source: string): readonly HostDashboardRouteSummary[] {
  return kernels.parseCaddyRoutes(source);
}

export function collectLocalHostDashboardSnapshot(input: {
  readonly target: HostDashboardTarget;
  readonly dockerSocketPath?: string;
  readonly runtimeRoot?: string;
}): Promise<HostDashboardSnapshot> {
  return kernels.collectLocalHostDashboardSnapshot(input);
}

export function fetchRemoteHostDashboardSnapshot(input: {
  readonly target: HostDashboardTarget;
  readonly authToken?: string;
  readonly timeoutMs: number;
}): Promise<HostDashboardSnapshot> {
  return kernels.fetchRemoteHostDashboardSnapshot(input);
}
