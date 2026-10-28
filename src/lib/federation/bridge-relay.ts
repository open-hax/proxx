/**
 * Shim kept for src/tests/federation-bridge-agent.test.ts (regression evidence).
 * The relay is proxx.runtime.federation-relay (CLJS); its types live in ../cljs-kernels.ts.
 */
import { kernels, type FederationBridgeRelay } from "../cljs-kernels.js";

export type * from "../cljs-kernels.js";

export const createFederationBridgeRelay = (): FederationBridgeRelay => kernels.createBridgeRelay() as FederationBridgeRelay;
