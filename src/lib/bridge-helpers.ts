import type { FastifyReply } from "fastify";
import type { BridgeRelayResponseEvent } from "./federation/bridge-relay.js";

const LEGACY_BRIDGE_PATH_PREFIXES = [
  "/v1/chat/completions",
  "/v1/models",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/images/generations",
] as const;

export function bridgeCapabilitySupportsPath(capability: {
  readonly paths?: readonly string[];
  readonly routes?: readonly string[];
  readonly supportsModelsList?: boolean;
  readonly supportsChatCompletions?: boolean;
  readonly supportsResponses?: boolean;
}, normalizedPath: string): boolean {
  const advertisedRoutes = [...(capability.paths ?? []), ...(capability.routes ?? [])]
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (advertisedRoutes.length > 0) {
    return advertisedRoutes.some((prefix) => normalizedPath.startsWith(prefix));
  }

  if (normalizedPath.startsWith("/v1/models")) {
    return capability.supportsModelsList === true;
  }
  if (normalizedPath.startsWith("/v1/chat/completions")) {
    return capability.supportsChatCompletions === true;
  }
  if (normalizedPath.startsWith("/v1/responses")) {
    return capability.supportsResponses === true;
  }

  const hasStructuredCapabilityHints = capability.supportsModelsList !== undefined
    || capability.supportsChatCompletions !== undefined
    || capability.supportsResponses !== undefined;

  return !hasStructuredCapabilityHints
    && LEGACY_BRIDGE_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

export function bridgeCapabilitySupportsModel(capability: {
  readonly models?: readonly string[];
  readonly modelPrefixes?: readonly string[];
}, requestedModel: string | undefined): boolean {
  if (!requestedModel) {
    return true;
  }

  const normalizedModel = requestedModel.trim();
  if (normalizedModel.length === 0) {
    return true;
  }

  const advertisedModels = (capability.models ?? [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (advertisedModels.includes(normalizedModel)) {
    return true;
  }

  const advertisedPrefixes = (capability.modelPrefixes ?? [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return advertisedPrefixes.some((prefix) => normalizedModel.startsWith(prefix));
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
