import type { FastifyReply } from "fastify";

import { kernels } from "../cljs-kernels.js";
import type { BridgeRelayResponseEvent } from "./bridge-relay.js";

// Implementation: proxx.federation.bridge-request (pure).

export const bridgeCapabilitySupportsPath = (capability: {
  readonly paths?: readonly string[];
  readonly routes?: readonly string[];
  readonly supportsModelsList?: boolean;
  readonly supportsChatCompletions?: boolean;
  readonly supportsResponses?: boolean;
}, normalizedPath: string): boolean => kernels.bridgeCapabilitySupportsPath(capability, normalizedPath);

export const bridgeCapabilitySupportsModel = (capability: {
  readonly models?: readonly string[];
  readonly modelPrefixes?: readonly string[];
}, requestedModel: string | undefined): boolean => kernels.bridgeCapabilitySupportsModel(capability, requestedModel);

export function appendBridgeResponseHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of kernels.forwardableBridgeResponseHeaders(headers, true)) {
    reply.header(name, value);
  }
}

export function decodeBridgeResponseChunk(
  event: Extract<BridgeRelayResponseEvent, { readonly type: "response_chunk" }>,
): Buffer {
  return event.encoding === "base64"
    ? Buffer.from(event.chunk, "base64")
    : Buffer.from(event.chunk, "utf8");
}
