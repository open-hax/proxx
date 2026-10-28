/**
 * Shim kept for src/tests/federation-bridge-protocol.test.ts (regression evidence).
 * The protocol is proxx.federation.protocol (CLJS); its types live in ../cljs-kernels.ts.
 */
import { kernels, type BridgeMessage } from "../cljs-kernels.js";

export type * from "../cljs-kernels.js";

export const BRIDGE_PROTOCOL_VERSION = "bridge-ws-v0" as const;

if (kernels.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
  throw new Error(`bridge protocol version mismatch: TypeScript ${BRIDGE_PROTOCOL_VERSION}, CLJS ${kernels.bridgeProtocolVersion}`);
}

export const parseBridgeMessage = (value: unknown): BridgeMessage => kernels.parseBridgeMessage(value);

export const parseBridgeMessageJson = (jsonText: string): BridgeMessage => kernels.parseBridgeMessageJson(jsonText);
