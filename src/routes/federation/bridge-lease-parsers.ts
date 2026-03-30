export interface BridgeLeaseAccountSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
}

export interface BridgeLeaseExportedAccount {
  readonly authType: "api_key" | "oauth_bearer";
  readonly secret: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseBridgeLeaseAccounts(payload: unknown, fallbackProviderId: string): BridgeLeaseAccountSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
    return [];
  }

  return payload.accounts
    .filter(isRecord)
    .map((entry): BridgeLeaseAccountSummary => ({
      providerId: typeof entry.providerId === "string" ? entry.providerId : fallbackProviderId,
      accountId: typeof entry.accountId === "string" ? entry.accountId : "",
      authType: entry.authType === "oauth_bearer" ? "oauth_bearer" : "api_key",
      expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : undefined,
      chatgptAccountId: typeof entry.chatgptAccountId === "string" ? entry.chatgptAccountId : undefined,
      planType: typeof entry.planType === "string" ? entry.planType : undefined,
    }))
    .filter((entry) => entry.accountId.trim().length > 0);
}

export function parseBridgeLeaseExport(payload: unknown): BridgeLeaseExportedAccount | undefined {
  if (!isRecord(payload) || !isRecord(payload.account)) {
    return undefined;
  }

  const account = payload.account;
  const secret = typeof account.secret === "string" ? account.secret : "";
  if (!secret) {
    return undefined;
  }

  return {
    authType: account.authType === "oauth_bearer" ? "oauth_bearer" : "api_key",
    secret,
    expiresAt: typeof account.expiresAt === "number" ? account.expiresAt : undefined,
    chatgptAccountId: typeof account.chatgptAccountId === "string" ? account.chatgptAccountId : undefined,
    email: typeof account.email === "string" ? account.email : undefined,
    subject: typeof account.subject === "string" ? account.subject : undefined,
    planType: typeof account.planType === "string" ? account.planType : undefined,
  };
}
