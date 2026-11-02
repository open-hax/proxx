import { kernels } from "../cljs-kernels.js";

// Decisions live in proxx.federation.helpers (pure); the fetch is proxx.runtime.federation-routing.

export const extractPeerCredential = (auth: Record<string, unknown>): string | undefined =>
  kernels.extractPeerCredential(auth);

export const resolveFederationHopCount = (headers: Record<string, unknown>): number =>
  kernels.resolveFederationHopCount(headers);

export const resolveFederationOwnerSubject = (input: {
  readonly headers: Record<string, unknown>;
  readonly requestAuth?: { readonly kind?: string; readonly subject?: string; readonly tenantId?: string };
  readonly hopCount?: number;
}): string | undefined =>
  kernels.resolveFederationOwnerSubject(input, process.env.FEDERATION_DEFAULT_OWNER_SUBJECT);

export const fetchFederationJson = <T>(input: {
  readonly url: string;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly method?: "GET" | "POST";
  readonly body?: Record<string, unknown>;
}): Promise<T> => kernels.fetchFederationJson(input) as Promise<T>;
