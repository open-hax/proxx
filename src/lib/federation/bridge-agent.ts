/**
 * Shim kept for src/tests/federation-bridge-agent.test.ts (regression evidence).
 * The agent is proxx.runtime.federation-agent (CLJS); its types live in ../cljs-kernels.ts.
 */
import { kernels, type FederationBridgeAgent, type FederationBridgeAgentOptions } from "../cljs-kernels.js";

export type * from "../cljs-kernels.js";

export const createFederationBridgeAgent = (options: FederationBridgeAgentOptions): FederationBridgeAgent =>
  kernels.createBridgeAgent(options) as FederationBridgeAgent;
