import type { FastifyInstance, FastifyReply } from "fastify";

import type { ProxyConfig } from "../config.js";
import {
  parseJsonIfPossible,
  normalizeRequestedModel,
} from "../request-utils.js";
import {
  toErrorMessage,
} from "../provider-utils.js";
import {
  bridgeCapabilitySupportsPath,
  bridgeCapabilitySupportsModel,
  appendBridgeResponseHeaders,
  decodeBridgeResponseChunk,
} from "../bridge-helpers.js";
import {
  resolveFederationHopCount,
  resolveFederationOwnerSubject,
} from "./federation-helpers.js";
import { isAtDid } from "./owner-credential.js";
import {
  shareModeAllowsRelay,
  tenantProviderPolicyAllowsUse,
  type TenantProviderPolicyRecord,
} from "../tenant-provider-policy.js";
import { applyNativeOllamaAuth } from "../native-auth.js";
import type { SqlTenantProviderPolicyStore } from "../db/sql-tenant-provider-policy-store.js";
import type { RuntimeCredentialStore } from "../runtime-credential-store.js";
import type { KeyPool } from "../key-pool.js";
import type { FederationBridgeRelay } from "./bridge-relay.js";
import type { BridgeRequestHandlerResult } from "./bridge-agent.js";

export const FEDERATION_HOP_HEADER = "x-open-hax-federation-hop";
export const FEDERATION_OWNER_SUBJECT_HEADER = "x-open-hax-federation-owner-subject";
export const FEDERATION_BRIDGE_TENANT_HEADER = "x-open-hax-bridge-tenant-id";
export const FEDERATION_FORCED_PROVIDER_HEADER = "x-open-hax-forced-provider";
export const FEDERATION_FORCED_ACCOUNT_ID_HEADER = "x-open-hax-forced-account-id";
export const FEDERATION_ROUTED_PEER_HEADER = "x-open-hax-federation-routed-peer";
export const FEDERATION_ROUTED_PROVIDER_HEADER = "x-open-hax-federation-routed-provider";
export const FEDERATION_ROUTED_ACCOUNT_HEADER = "x-open-hax-federation-routed-account";
export const FEDERATION_IMPORTED_HEADER = "x-open-hax-federation-imported";
export const FEDERATION_BLOCKED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "x-open-hax-federation-hop",
  "x-open-hax-federation-owner-subject",
  "x-open-hax-federation-routed-peer",
  "x-open-hax-federation-routed-provider",
  "x-open-hax-federation-routed-account",
  "x-open-hax-federation-imported",
  "x-open-hax-forced-provider",
  "x-open-hax-forced-account-id",
]);

export interface BridgeFallbackDeps {
  readonly bridgeRelay: FederationBridgeRelay | undefined;
  readonly app: FastifyInstance;
  readonly config: ProxyConfig;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly keyPool: KeyPool;
  readonly sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;
}

export async function executeBridgeRequestFallback(
  deps: BridgeFallbackDeps,
  input: {
    readonly requestHeaders: Record<string, unknown>;
    readonly requestBody: Record<string, unknown>;
    readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string; readonly tenantId?: string };
    readonly upstreamPath: string;
    readonly reply: FastifyReply;
    readonly timeoutMs: number;
  },
): Promise<boolean> {
  const { bridgeRelay, app, sqlTenantProviderPolicyStore } = deps;

  if (!bridgeRelay) {
    return false;
  }

  // Reject multi-hop bridge routing to prevent request loops
  const hopCount = resolveFederationHopCount(input.requestHeaders);
  if (hopCount >= 1) {
    app.log.warn({ hopCount, upstreamPath: input.upstreamPath }, "bridge request rejected: hop limit exceeded");
    return false;
  }

  const ownerSubject = resolveFederationOwnerSubject({
    headers: input.requestHeaders,
    requestAuth: input.requestAuth,
    hopCount,
  });
  if (!ownerSubject) {
    return false;
  }

  const DEFAULT_TENANT_ID = "default";
  const tenantId = input.requestAuth?.tenantId
    ?? (input.requestAuth?.kind === "legacy_admin" ? DEFAULT_TENANT_ID : undefined);
  if (!tenantId) {
    return false;
  }

  const requestedModel = normalizeRequestedModel(input.requestBody.model);
  const subjectDid = typeof input.requestAuth?.subject === "string" && isAtDid(input.requestAuth.subject)
    ? input.requestAuth.subject.trim()
    : typeof input.requestAuth?.tenantId === "string" && isAtDid(input.requestAuth.tenantId)
      ? input.requestAuth.tenantId.trim()
      : undefined;

  const resolveBridgePolicy = async (providerId: string): Promise<TenantProviderPolicyRecord | null | undefined> => {
    if (!subjectDid || !sqlTenantProviderPolicyStore) {
      return undefined;
    }

    const policy = await sqlTenantProviderPolicyStore.getPolicy(subjectDid, providerId);
    if (!policy) {
      return null;
    }

    if (!tenantProviderPolicyAllowsUse(policy, {
      ownerSubject,
      providerKind: "peer_proxx",
      requestedModel,
      requiredShareMode: "relay",
    })) {
      return null;
    }

    return policy;
  };

  // Filter connected sessions by advertised capability for the requested path
  const normalizedPath = input.upstreamPath.split("?")[0]!;
  const connectedSessions = (await Promise.all(bridgeRelay.listSessions()
    .filter((session) => session.state === "connected")
    .filter((session) => session.ownerSubject === ownerSubject)
    .filter((session) => session.tenantId === tenantId)
    .map(async (session) => {
      for (const capability of session.capabilities) {
        if (!bridgeCapabilitySupportsPath(capability, normalizedPath)
          || !bridgeCapabilitySupportsModel(capability, requestedModel)) {
          continue;
        }

        const policy = await resolveBridgePolicy(capability.providerId);
        if (policy === null || (policy && !shareModeAllowsRelay(policy.shareMode))) {
          continue;
        }

        return session;
      }

      return undefined;
    })))
    .filter((session): session is NonNullable<typeof session> => session !== undefined);
  if (connectedSessions.length === 0) {
    return false;
  }

  const bodyText = JSON.stringify(input.requestBody);

  for (const session of connectedSessions) {
    let responseStarted = false;
    let rawResponse: typeof input.reply.raw | undefined;
    try {
      const responseEvents = bridgeRelay.requestStream(session.sessionId, {
        method: "POST",
        path: input.upstreamPath,
        timeoutMs: input.timeoutMs,
        headers: {
          accept: typeof input.requestHeaders.accept === "string" ? input.requestHeaders.accept : "application/json",
          "content-type": "application/json",
        },
        body: bodyText,
        requestContext: { tenantId },
        routingIntent: requestedModel ? { model: requestedModel } : undefined,
      });

      let sawHead = false;
      let isStreaming = false;
      let responseHeaders: Readonly<Record<string, string>> = {};
      const bufferedChunks: Buffer[] = [];

      for await (const event of responseEvents) {
        switch (event.type) {
          case "response_head": {
            sawHead = true;
            responseStarted = true;
            responseHeaders = event.headers;
            appendBridgeResponseHeaders(input.reply, event.headers);
            input.reply.header(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
            input.reply.header(FEDERATION_ROUTED_PEER_HEADER, `bridge:${session.clusterId}:${session.agentId}`);
            input.reply.code(event.status);

            const contentType = event.headers["content-type"] ?? event.headers["Content-Type"] ?? "";
            isStreaming = typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
            if (isStreaming) {
              input.reply.removeHeader("content-length");
              input.reply.header("cache-control", "no-cache");
              input.reply.header("x-accel-buffering", "no");
              input.reply.header("content-type", "text/event-stream; charset=utf-8");
              input.reply.hijack();
              rawResponse = input.reply.raw;
              rawResponse.statusCode = event.status;
              for (const [name, value] of Object.entries(input.reply.getHeaders())) {
                if (value !== undefined) {
                  rawResponse.setHeader(name, value as never);
                }
              }
              rawResponse.flushHeaders();
            }
            break;
          }
          case "response_chunk": {
            if (!sawHead) {
              sawHead = true;
              responseStarted = true;
              input.reply.header(FEDERATION_OWNER_SUBJECT_HEADER, ownerSubject);
              input.reply.header(FEDERATION_ROUTED_PEER_HEADER, `bridge:${session.clusterId}:${session.agentId}`);
              input.reply.code(200);
            }

            const chunk = decodeBridgeResponseChunk(event);
            if (isStreaming && rawResponse) {
              rawResponse.write(chunk);
            } else {
              bufferedChunks.push(chunk);
            }
            break;
          }
          case "response_end":
            break;
          default:
            break;
        }
      }

      if (isStreaming && rawResponse) {
        if (!rawResponse.writableEnded) {
          rawResponse.end();
        }
        return true;
      }

      const responseBody = Buffer.concat(bufferedChunks).toString("utf8");
      const contentType = responseHeaders["content-type"] ?? responseHeaders["Content-Type"] ?? "";
      const parsed = typeof contentType === "string" && contentType.toLowerCase().includes("application/json")
        ? parseJsonIfPossible(responseBody)
        : undefined;
      if (parsed !== undefined) {
        input.reply.send(parsed);
      } else {
        input.reply.send(responseBody);
      }
      return true;
    } catch (error) {
      if (rawResponse && !rawResponse.writableEnded) {
        rawResponse.end();
      }
      app.log.warn({ error: toErrorMessage(error), sessionId: session.sessionId, upstreamPath: input.upstreamPath }, "bridged request attempt failed");
      if (responseStarted) {
        return true;
      }
    }
  }

  return false;
}

export const handleBridgeRequest = async (
  deps: BridgeFallbackDeps,
  input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
    readonly ownerSubject: string;
    readonly tenantId?: string;
  },
): Promise<BridgeRequestHandlerResult> => {
  const { app } = deps;

  // Security: restrict bridge requests to allowed API paths only.
  // This prevents the bridge from acting as a privileged generic proxy
  // that could access internal routes like /api/ui/federation/accounts.
  const allowedBridgePaths = [
    "/v1/chat/completions",
    "/v1/models",
    "/v1/responses",
    "/v1/embeddings",
    "/v1/images/generations",
  ];
  const normalizedPath = input.path.split("?")[0]!;
  if (!allowedBridgePaths.some((prefix) => normalizedPath.startsWith(prefix))) {
    app.log.warn({ path: input.path, ownerSubject: input.ownerSubject }, "bridge request rejected: path not in allowed list");
    return {
      status: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "Bridge requests are restricted to model API paths", type: "invalid_request_error" } }),
      servedByClusterId: process.env.FEDERATION_SELF_CLUSTER_ID?.trim(),
      servedByGroupId: process.env.FEDERATION_SELF_GROUP_ID?.trim(),
      servedByNodeId: process.env.FEDERATION_SELF_NODE_ID?.trim(),
    };
  }

  const headers: Record<string, string> = {
    accept: input.headers.accept ?? "application/json",
    // Use a dedicated bridge identity header instead of the global admin token.
    // This prevents the bridge from becoming a privileged proxy with admin access.
    "x-open-hax-bridge-auth": "internal",
    [FEDERATION_HOP_HEADER]: "1",
    [FEDERATION_OWNER_SUBJECT_HEADER]: input.ownerSubject,
  };
  if (typeof input.tenantId === "string" && input.tenantId.trim().length > 0) {
    headers[FEDERATION_BRIDGE_TENANT_HEADER] = input.tenantId.trim();
  }
  if (typeof input.headers["content-type"] === "string") {
    headers["content-type"] = input.headers["content-type"];
  }

  const appAddress = app.server.address();
  if (appAddress && typeof appAddress !== "string") {
    const response = await fetch(`http://127.0.0.1:${appAddress.port}${input.path}`, {
      method: input.method,
      headers,
      body: input.bodyText.length > 0 ? input.bodyText : undefined,
    });

    return (async function* () {
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of response.headers.entries()) {
        responseHeaders[name] = value;
      }

      const providerId = responseHeaders["x-open-hax-upstream-provider"];
      const servedByClusterId = process.env.FEDERATION_SELF_CLUSTER_ID?.trim();
      const servedByGroupId = process.env.FEDERATION_SELF_GROUP_ID?.trim();
      const servedByNodeId = process.env.FEDERATION_SELF_NODE_ID?.trim();

      yield {
        type: "response_head" as const,
        status: response.status,
        headers: responseHeaders,
        servedByClusterId,
        servedByGroupId,
        servedByNodeId,
        providerId,
      };

      if (!response.body) {
        yield {
          type: "response_end" as const,
          servedByClusterId,
          servedByGroupId,
          servedByNodeId,
          providerId,
        };
        return;
      }

      const contentType = (response.headers.get("content-type") ?? "").trim().toLowerCase();
      const encodeAsUtf8 = contentType.length === 0
        || contentType.startsWith("text/")
        || contentType.includes("json")
        || contentType.includes("xml")
        || contentType.includes("javascript")
        || contentType.includes("event-stream");
      const decoder = encodeAsUtf8 ? new TextDecoder("utf8") : undefined;
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }

        if (decoder) {
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.length > 0) {
            yield {
              type: "response_chunk" as const,
              chunk,
              encoding: "utf8" as const,
              servedByClusterId,
              servedByGroupId,
              servedByNodeId,
              providerId,
            };
          }
          continue;
        }

        yield {
          type: "response_chunk" as const,
          chunk: Buffer.from(value).toString("base64"),
          encoding: "base64" as const,
          servedByClusterId,
          servedByGroupId,
          servedByNodeId,
          providerId,
        };
      }

      if (decoder) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          yield {
            type: "response_chunk" as const,
            chunk: tail,
            encoding: "utf8" as const,
            servedByClusterId,
            servedByGroupId,
            servedByNodeId,
            providerId,
          };
        }
      }

      yield {
        type: "response_end" as const,
        servedByClusterId,
        servedByGroupId,
        servedByNodeId,
        providerId,
      };
    })();
  }

  const injected = await app.inject({
    method: input.method as "GET" | "POST",
    url: input.path,
    headers,
    payload: input.bodyText.length > 0 ? input.bodyText : undefined,
  });

  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(injected.headers)) {
    if (typeof value === "string") {
      responseHeaders[name] = value;
    }
  }

  const provenance = {
    servedByClusterId: process.env.FEDERATION_SELF_CLUSTER_ID?.trim(),
    servedByGroupId: process.env.FEDERATION_SELF_GROUP_ID?.trim(),
    servedByNodeId: process.env.FEDERATION_SELF_NODE_ID?.trim(),
    providerId: responseHeaders["x-open-hax-upstream-provider"],
  };

  return {
    status: injected.statusCode,
    headers: responseHeaders,
    body: injected.body,
    encoding: "utf8",
    ...provenance,
  };
};

export async function injectNativeBridge(
  deps: BridgeFallbackDeps,
  url: string,
  payload: Record<string, unknown>,
  requestHeaders: Record<string, unknown>,
) {
  const { app, config } = deps;
  return app.inject({
    method: "POST",
    url,
    headers: {
      ...applyNativeOllamaAuth({ headers: requestHeaders } as never, config),
    },
    payload,
  });
}
