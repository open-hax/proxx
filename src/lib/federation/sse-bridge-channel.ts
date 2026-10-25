import type { ServerResponse } from "node:http";

import { kernels } from "../cljs-kernels.js";
import type { BridgeSendChannel } from "./bridge-send-channel.js";

export interface SseBridgeSession {
  readonly sessionId: string;
  readonly channel: BridgeSendChannel;
}

// Framing is proxx.federation.sse-channel (pure); the response handle lives in the CLJS edge.
export function createSseBridgeSendChannel(res: ServerResponse): BridgeSendChannel {
  return kernels.createSseBridgeSendChannel(res);
}

export function formatSseEvent(event: string, data: unknown): string {
  return kernels.formatSseEvent(event, data);
}
