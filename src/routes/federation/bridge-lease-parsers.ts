import { kernels } from "../../lib/cljs-kernels.js";

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

// Implementation: proxx.federation.lease (pure, tolerant of malformed peers).
export const parseBridgeLeaseAccounts = (payload: unknown, fallbackProviderId: string): BridgeLeaseAccountSummary[] =>
  kernels.parseBridgeLeaseAccounts(payload, fallbackProviderId);

export const parseBridgeLeaseExport = (payload: unknown): BridgeLeaseExportedAccount | undefined =>
  kernels.parseBridgeLeaseExport(payload);
