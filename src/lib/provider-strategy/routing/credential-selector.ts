import type { ProviderCredential } from "../../key-pool.js";
import type { RequestLogStore } from "../../request-log-store.js";
import {
  providerAccountsForRequest,
  reorderAccountsForLatency,
  reorderCandidatesForAffinities,
  reorderCandidatesForAffinity,
} from "../shared.js";

export interface PreferredAffinity {
  readonly providerId: string;
  readonly accountId: string;
}

/*
 * Credential ordering is decided in CLJS (proxx.strategy.routing, constants in
 * 77-upstream-attempt-policy.edn); these entry points keep the TS signatures.
 */
export { reorderCandidatesForAffinities, reorderCandidatesForAffinity, providerAccountsForRequest, reorderAccountsForLatency };

export type { ProviderCredential, RequestLogStore };
