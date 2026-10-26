import type { FastifyBaseLogger } from "fastify";

import { kernels } from "../cljs-kernels.js";
import { fetchFederationJson } from "./federation-helpers.js";
import { resolveFederationRoutePath } from "../../routes/federation/prefix.js";
import type { SqlFederationStore } from "../db/sql-federation-store.js";

export const resolveOnDemandPullTtlMs = (): number =>
  kernels.resolveOnDemandPullTtlMs(process.env.FEDERATION_ON_DEMAND_PULL_TTL_MS);

/**
 * Pull each active peer whose projections are stale. Decisions are proxx.federation.projections
 * (pure); the store sequencing is proxx.runtime.federation-projections. The federation fetch and
 * route-path builder remain TypeScript and are injected.
 */
export const ensureFederationProjectedAccountsFresh = (input: {
  readonly logger?: FastifyBaseLogger;
  readonly sqlFederationStore: SqlFederationStore;
  readonly ownerSubject: string;
  readonly timeoutMs: number;
}): Promise<{ readonly pulledPeerIds: readonly string[] } | undefined> =>
  kernels.ensureFederationProjectedAccountsFresh(input, { fetchFederationJson, resolveFederationRoutePath });
