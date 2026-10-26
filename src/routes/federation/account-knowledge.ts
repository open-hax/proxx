/**
 * Wire shapes of the federation account views. The merge that builds them is CLJS
 * (`proxx.http.federation/account-knowledge`); credential lookup for export is
 * `proxx.runtime.routes.federation`.
 */
import type { FederationProjectedAccountRecord } from "../../lib/db/sql-federation-store.js";

export interface FederationKnownAccountSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly authType?: "api_key" | "oauth_bearer";
  readonly planType?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly ownerSubject?: string;
  readonly sourcePeerId?: string;
  readonly projectedState?: string;
  readonly warmRequestCount?: number;
  readonly hasCredentials: boolean;
  readonly knowledgeSources: readonly string[];
  readonly cooldownUntilMs?: number;
}

export interface FederationAccountsResponse {
  readonly ownerSubject: string | null;
  readonly localAccounts: readonly FederationKnownAccountSummary[];
  readonly projectedAccounts: readonly FederationProjectedAccountRecord[];
  readonly knownAccounts: readonly FederationKnownAccountSummary[];
}

export interface FederationCredentialExport {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly secret: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly subject?: string;
  readonly planType?: string;
}
