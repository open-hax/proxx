import { joinRoutePath, type PrefixedRouteOptions } from "../types.js";

export type FederationRouteOptions = PrefixedRouteOptions;

export const LEGACY_FEDERATION_ROUTE_PREFIX = "/api/ui";
export const API_V1_FEDERATION_ROUTE_PREFIX = "/api/v1";

export function resolveFederationRoutePath(suffix: string, options?: PrefixedRouteOptions): string {
  return joinRoutePath(options?.prefix ?? LEGACY_FEDERATION_ROUTE_PREFIX, suffix);
}