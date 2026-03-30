import { joinRoutePath, type PrefixedRouteOptions } from "../types.js";

export const LEGACY_SETTINGS_ROUTE_PREFIX = "/api/ui";
export const API_V1_SETTINGS_ROUTE_PREFIX = "/api/v1";

export function resolveSettingsRoutePath(suffix: string, options?: PrefixedRouteOptions): string {
  return joinRoutePath(options?.prefix ?? LEGACY_SETTINGS_ROUTE_PREFIX, suffix);
}