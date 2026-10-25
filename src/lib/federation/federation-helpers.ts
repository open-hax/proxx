import { kernels } from "../cljs-kernels.js";
import { fetchWithResponseTimeout } from "../http/index.js";

// Decisions live in proxx.federation.helpers (pure); only the environment read and the fetch stay here.

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

export async function fetchFederationJson<T>(input: {
  readonly url: string;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly method?: "GET" | "POST";
  readonly body?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetchWithResponseTimeout(input.url, {
    method: input.method ?? "GET",
    headers: new Headers(kernels.federationJsonRequestHeaders(input.credential)),
    body: input.body ? JSON.stringify(input.body) : undefined,
  }, input.timeoutMs);

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(kernels.federationFailureMessage(parsed, response.status));
  }

  return parsed as T;
}
