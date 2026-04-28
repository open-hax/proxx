import { joinRoutePath, type PrefixedRouteOptions } from "../types.js";

export interface ObservabilityRouteOptions extends PrefixedRouteOptions {
  readonly includeRequestLogs?: boolean;
  readonly includeDashboardOverview?: boolean;
  readonly includeProviderModelAnalytics?: boolean;
  readonly includeTools?: boolean;
  readonly includeMcpServers?: boolean;
}

export const LEGACY_OBSERVABILITY_ROUTE_PREFIX = "/api/ui";
export const API_V1_OBSERVABILITY_ROUTE_PREFIX = "/api/v1";

export function resolveObservabilityRoutePath(suffix: string, options?: PrefixedRouteOptions): string {
  return joinRoutePath(options?.prefix ?? LEGACY_OBSERVABILITY_ROUTE_PREFIX, suffix);
}
