import { joinRoutePath, type PrefixedRouteOptions } from "../types.js";

export interface CredentialRouteOptions extends PrefixedRouteOptions {
  readonly registerSharedAuthCallbacks?: boolean;
}

export const LEGACY_CREDENTIAL_ROUTE_PREFIX = "/api/ui";
export const API_V1_CREDENTIAL_ROUTE_PREFIX = "/api/v1";

export function resolveCredentialRoutePath(suffix: string, options?: PrefixedRouteOptions): string {
  return joinRoutePath(options?.prefix ?? LEGACY_CREDENTIAL_ROUTE_PREFIX, suffix);
}