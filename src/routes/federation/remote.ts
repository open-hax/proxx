export function extractPeerCredential(auth: Record<string, unknown>): string | undefined {
  const direct = typeof auth.credential === "string" ? auth.credential.trim() : "";
  if (direct.length > 0) {
    return direct;
  }

  const bearer = typeof auth.bearer === "string" ? auth.bearer.trim() : "";
  return bearer.length > 0 ? bearer : undefined;
}

export async function fetchFederationJson<T>(input: {
  readonly url: string;
  readonly credential?: string;
  readonly timeoutMs: number;
  readonly method?: "GET" | "POST";
  readonly body?: Record<string, unknown>;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    if (input.credential && input.credential.length > 0) {
      headers.set("authorization", `Bearer ${input.credential}`);
    }

    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) as T & { readonly error?: string } : {} as T & { readonly error?: string };
    if (!response.ok) {
      const detail = typeof parsed.error === "string" ? parsed.error : `request failed with ${response.status}`;
      throw new Error(detail);
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

function projectedAccountAuthType(projectedAccount: {
  readonly metadata: Record<string, unknown>;
}): "api_key" | "oauth_bearer" | undefined {
  const raw = projectedAccount.metadata.authType;
  if (raw === "api_key" || raw === "oauth_bearer") {
    return raw;
  }

  return undefined;
}

function projectedAccountCredentialMobility(projectedAccount: {
  readonly metadata: Record<string, unknown>;
}): string | undefined {
  const raw = projectedAccount.metadata.credentialMobility;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function projectedAccountAllowsCredentialImport(projectedAccount: {
  readonly metadata: Record<string, unknown>;
}): boolean {
  const mobility = projectedAccountCredentialMobility(projectedAccount);
  const authType = projectedAccountAuthType(projectedAccount);

  // Explicit non-exportable flags always win.
  if (mobility === "non_exportable" || mobility === "descriptor_only" || mobility === "local_only") {
    return false;
  }

  // OAuth refresh tokens stay on the minting node, but access tokens may be leased.
  if (authType === "oauth_bearer") {
    return mobility === "access_token_only";
  }

  return true;
}
