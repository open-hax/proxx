import { joinRoutePath, type PrefixedRouteOptions } from "../types.js";

export const LEGACY_SESSION_ROUTE_PREFIX = "/api/ui";
export const API_V1_SESSION_ROUTE_PREFIX = "/api/v1";

export function resolveSessionRoutePath(suffix: string, options?: PrefixedRouteOptions): string {
  return joinRoutePath(options?.prefix ?? LEGACY_SESSION_ROUTE_PREFIX, suffix);
}