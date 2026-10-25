import type { FastifyReply } from "fastify";
import type { BridgeRelayResponseEvent } from "./federation/bridge-relay.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * Whether a bridge's advertised capability lets it serve `normalizedPath`.
 * The decision (advertised routes, structured hints, legacy path set from the
 * `:provider-surface-facts` contract) is the CLJS kernel `proxx.routing.bridge`.
 */
export function bridgeCapabilitySupportsPath(capability: {
  readonly paths?: readonly string[];
  readonly routes?: readonly string[];
  readonly supportsModelsList?: boolean;
  readonly supportsChatCompletions?: boolean;
  readonly supportsResponses?: boolean;
}, normalizedPath: string): boolean {
  return kernels.bridgeCapabilitySupportsPath(policyManifestPath(), capability, normalizedPath);
}

export function bridgeCapabilitySupportsModel(capability: {
  readonly models?: readonly string[];
  readonly modelPrefixes?: readonly string[];
}, requestedModel: string | undefined): boolean {
  return kernels.bridgeCapabilitySupportsModel(capability, requestedModel);
}

export function appendBridgeResponseHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-length") {
      continue;
    }
    reply.header(name, value);
  }
}

export function decodeBridgeResponseChunk(event: Extract<BridgeRelayResponseEvent, { readonly type: "response_chunk" }>): Buffer {
  return event.encoding === "base64"
    ? Buffer.from(event.chunk, "base64")
    : Buffer.from(event.chunk, "utf8");
}
