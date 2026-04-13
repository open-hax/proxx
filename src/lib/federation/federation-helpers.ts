import { fetchWithResponseTimeout } from "../provider-utils.js";
import { readSingleHeader } from "../request-utils.js";

const FEDERATION_HOP_HEADER = "x-open-hax-federation-hop";
const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";

export function extractPeerCredential(auth: Record<string, unknown>): string | undefined {
  const direct = typeof auth.credential === "string" ? auth.credential.trim() : "";
  if (direct.length > 0) {
    return direct;
  }

  const bearer = typeof auth.bearer === "string" ? auth.bearer.trim() : "";
  return bearer.length > 0 ? bearer : undefined;
}

export function resolveFederationHopCount(headers: Record<string, unknown>): number {
  const raw = readSingleHeader(headers, FEDERATION_HOP_HEADER)?.trim();
  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function resolveFederationOwnerSubject(input: {
  readonly headers: Record<string, unknown>;
  readonly requestAuth?: { readonly kind?: string; readonly subject?: string };
  readonly hopCount?: number;
}): string | undefined {
  const explicitHeader = readSingleHeader(input.headers, FEDERATION_OWNER_SUBJECT_HEADER)?.trim();
  if (explicitHeader && ((input.hopCount ?? 0) > 0 || input.requestAuth?.kind === "legacy_admin")) {
    return explicitHeader;
  }

  const authSubject = input.requestAuth?.subject?.trim();
  if (authSubject && authSubject !== "legacy:proxy-auth-token") {
    return authSubject;
  }

  if (input.requestAuth?.kind === "legacy_admin") {
    const defaultOwnerSubject = process.env.FEDERATION_DEFAULT_OWNER_SUBJECT?.trim();
    if (defaultOwnerSubject) {
      return defaultOwnerSubject;
    }
  }

  return undefined;
}

export async function fetchFederationJson<T>(input: {
  readonly url: string;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly method?: "GET" | "POST";
  readonly body?: Record<string, unknown>;
}): Promise<T> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (input.credential && input.credential.length > 0) {
    headers.set("authorization", `Bearer ${input.credential}`);
  }

  const response = await fetchWithResponseTimeout(input.url, {
    method: input.method ?? "GET",
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
  }, input.timeoutMs);

  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) as T & { readonly error?: string } : {} as T & { readonly error?: string };
  if (!response.ok) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : `request failed with ${response.status}`);
  }

  return parsed as T;
}
