import type { FastifyInstance, FastifyReply } from "fastify";

import type { ProxyConfig } from "../config.js";
import {
  parseJsonIfPossible,
  normalizeRequestedModel,
} from "../request-utils.js";
import {
  toErrorMessage,
} from "../errors/index.js";
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
import type { TenantProviderPolicyRecord } from "../db/sql-tenant-provider-policy-store.js";
import { getActiveCljsRuntime } from "../cljs-runtime.js";
import { kernels } from "../cljs-kernels.js";
import { applyNativeOllamaAuth } from "../native-auth.js";
import type { SqlTenantProviderPolicyStore } from "../db/sql-tenant-provider-policy-store.js";
import type { RuntimeCredentialStore } from "../runtime-credential-store.js";
import type { KeyPool } from "../key-pool.js";
import type { FederationBridgeRelay } from "./bridge-relay.js";
import type { BridgeRequestHandlerResult } from "./bridge-agent.js";

const routing = kernels.federationRouting;
const headerNames = kernels.federationHeaders;

export const FEDERATION_HOP_HEADER = headerNames.hop;
export const FEDERATION_OWNER_SUBJECT_HEADER = headerNames.ownerSubject;
export const FEDERATION_BRIDGE_TENANT_HEADER = headerNames.bridgeTenant;
export const FEDERATION_FORCED_PROVIDER_HEADER = headerNames.forcedProvider;
export const FEDERATION_FORCED_ACCOUNT_ID_HEADER = headerNames.forcedAccountId;
export const FEDERATION_ROUTED_PEER_HEADER = headerNames.routedPeer;
export const FEDERATION_ROUTED_PROVIDER_HEADER = headerNames.routedProvider;
export const FEDERATION_ROUTED_ACCOUNT_HEADER = headerNames.routedAccount;
export const FEDERATION_IMPORTED_HEADER = headerNames.imported;
export const FEDERATION_BLOCKED_RESPONSE_HEADERS = new Set(headerNames.blockedResponseHeaders);

export interface BridgeRoutingDeps {
  readonly bridgeRelay: FederationBridgeRelay | undefined;
  readonly app: FastifyInstance;
  readonly config: ProxyConfig;
  readonly runtimeCredentialStore: RuntimeCredentialStore;
  readonly keyPool: KeyPool;
  readonly sqlTenantProviderPolicyStore: SqlTenantProviderPolicyStore | undefined;
}

function authorizeTenantProviderPolicy(
  deps: BridgeRoutingDeps,
  policy: TenantProviderPolicyRecord,
  input: {
    readonly ownerSubject: string;
    readonly providerKind: "local_upstream" | "peer_proxx";
    readonly requestedModel?: string;
    readonly requestKind?: string;
    readonly requiredShareMode?: "relay" | "warm_import" | "project_credentials";
  },
): boolean {
  const runtime = getActiveCljsRuntime();
  const result = runtime?.authorizeTenantProviderPolicy?.(
    deps.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn",
    { policy, ...input },
  );
  return result?.status === "ok" && result.allowed === true;
}

export async function executeBridgeRequestRouting(
  deps: BridgeRoutingDeps,
  input: {
    readonly requestHeaders: Record<string, unknown>;
    readonly requestBody: Record<string, unknown>;
    readonly requestAuth?: { readonly kind: "legacy_admin" | "tenant_api_key" | "ui_session" | "unauthenticated"; readonly subject?: string; readonly tenantId?: string };
    readonly requestKind?: string;
    readonly allowedProviderIds?: readonly string[];
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
  if (routing.hopLimitExceeded(hopCount)) {
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

  const tenantId = routing.bridgeTenantId(input.requestAuth);
  if (!tenantId) {
    return false;
  }

  const requestedModel = normalizeRequestedModel(input.requestBody.model);
  const subjectDid = routing.subjectDid(input.requestAuth);

  const resolveBridgePolicy = async (providerId: string): Promise<TenantProviderPolicyRecord | null | undefined> => {
    if (!subjectDid || !sqlTenantProviderPolicyStore) {
      return undefined;
    }

    const policy = await sqlTenantProviderPolicyStore.getPolicy(subjectDid, providerId);
    if (!policy) {
      return null;
    }

    if (!authorizeTenantProviderPolicy(deps, policy, {
      ownerSubject,
      providerKind: "peer_proxx",
      requestedModel,
      requestKind: input.requestKind,
      requiredShareMode: "relay",
    })) {
      return null;
    }

    return policy;
  };

  // Filter connected sessions by advertised capability for the requested path
  const normalizedPath = routing.normalizedPath(input.upstreamPath);
  const allowedProviderIds = routing.allowedProviderIds(input.allowedProviderIds ?? []);
  const connectedSessions = (await Promise.all(bridgeRelay.listSessions()
    .filter((session) => routing.sessionEligible(session, ownerSubject, tenantId))
    .map(async (session) => {
      for (const capability of session.capabilities) {
        if (!routing.capabilityAdmissible(capability, allowedProviderIds)
          || !bridgeCapabilitySupportsPath(capability, normalizedPath)
          || !bridgeCapabilitySupportsModel(capability, requestedModel)) {
          continue;
        }

        const policy = await resolveBridgePolicy(capability.providerId);
        if (policy === null) {
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
            input.reply.header(FEDERATION_ROUTED_PEER_HEADER, routing.routedPeerLabel(session.clusterId, session.agentId));
            input.reply.code(event.status);

            isStreaming = routing.eventStreamContentType(routing.responseContentType(event.headers));
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
              input.reply.header(FEDERATION_ROUTED_PEER_HEADER, routing.routedPeerLabel(session.clusterId, session.agentId));
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
      const parsed = routing.jsonContentType(routing.responseContentType(responseHeaders))
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
  deps: BridgeRoutingDeps,
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

  // Security: restrict bridge requests to allowed API paths only, so the bridge cannot act as a
  // privileged generic proxy onto internal routes (e.g. /api/ui/federation/accounts).
  if (!routing.bridgePathAllowed(input.path)) {
    app.log.warn({ path: input.path, ownerSubject: input.ownerSubject }, "bridge request rejected: path not in allowed list");
    return {
      status: 403,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routing.bridgeForbiddenBody()),
      servedByClusterId: process.env.FEDERATION_SELF_CLUSTER_ID?.trim(),
      servedByGroupId: process.env.FEDERATION_SELF_GROUP_ID?.trim(),
      servedByNodeId: process.env.FEDERATION_SELF_NODE_ID?.trim(),
    };
  }

  const headers = routing.bridgeRequestHeaders({
    accept: input.headers.accept,
    contentType: input.headers["content-type"],
    ownerSubject: input.ownerSubject,
    tenantId: input.tenantId,
  });

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

      const encodeAsUtf8 = routing.utf8ChunkEncoding(response.headers.get("content-type") ?? "");
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
  deps: BridgeRoutingDeps,
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
