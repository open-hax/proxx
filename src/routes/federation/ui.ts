import type { FastifyInstance } from "fastify";

import {
  authCanManageFederation,
  getResolvedAuth,
  parseOptionalPositiveInteger,
} from "../shared/ui-auth.js";
import type { UiRouteDependencies } from "../types.js";
import {
  normalizeTenantProviderKind,
  normalizeTenantProviderShareMode,
  normalizeTenantProviderTrustTier,
} from "../../lib/tenant-provider-policy.js";

export async function registerFederationUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): Promise<void> {
  app.get<{
    Querystring: { readonly ownerSubject?: string };
  }>("/api/ui/federation/peers", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const peers = await deps.sqlFederationStore.listPeers(ownerSubject);
    reply.send({ peers });
  });

  app.get("/api/ui/federation/self", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    const peerCount = deps.sqlFederationStore
      ? (await deps.sqlFederationStore.listPeers()).length
      : 0;

    reply.send({
      nodeId: process.env.FEDERATION_SELF_NODE_ID ?? null,
      groupId: process.env.FEDERATION_SELF_GROUP_ID ?? null,
      clusterId: process.env.FEDERATION_SELF_CLUSTER_ID ?? null,
      peerDid: process.env.FEDERATION_SELF_PEER_DID ?? null,
      publicBaseUrl: process.env.FEDERATION_SELF_PUBLIC_BASE_URL ?? null,
      peerCount,
    });
  });

  app.post<{
    Body: {
      readonly id?: string;
      readonly ownerCredential?: string;
      readonly peerDid?: string;
      readonly label?: string;
      readonly baseUrl?: string;
      readonly controlBaseUrl?: string;
      readonly auth?: Record<string, unknown>;
      readonly capabilities?: Record<string, unknown>;
      readonly status?: string;
    };
  }>("/api/ui/federation/peers", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlFederationStore) {
      reply.code(503).send({ error: "federation_store_not_supported" });
      return;
    }

    const ownerCredential = typeof request.body?.ownerCredential === "string" ? request.body.ownerCredential.trim() : "";
    const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
    const baseUrl = typeof request.body?.baseUrl === "string" ? request.body.baseUrl.trim() : "";

    if (!ownerCredential || !label || !baseUrl) {
      reply.code(400).send({ error: "owner_credential_label_and_base_url_required" });
      return;
    }

    const peer = await deps.sqlFederationStore.upsertPeer({
      id: request.body?.id,
      ownerCredential,
      peerDid: request.body?.peerDid,
      label,
      baseUrl,
      controlBaseUrl: request.body?.controlBaseUrl,
      auth: request.body?.auth,
      capabilities: request.body?.capabilities,
      status: request.body?.status,
    });
    await deps.sqlFederationStore.appendDiffEvent({
      ownerSubject: peer.ownerSubject,
      entityType: "peer",
      entityKey: peer.id,
      op: "upsert",
      payload: {
        peerDid: peer.peerDid,
        label: peer.label,
        baseUrl: peer.baseUrl,
        controlBaseUrl: peer.controlBaseUrl,
        authMode: peer.authMode,
        status: peer.status,
      },
    });

    reply.code(201).send({ peer });
  });

  app.get<{
    Querystring: { readonly ownerSubject?: string; readonly subjectDid?: string };
  }>("/api/ui/federation/tenant-provider-policies", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const ownerSubject = typeof request.query.ownerSubject === "string" && request.query.ownerSubject.trim().length > 0
      ? request.query.ownerSubject.trim()
      : undefined;
    const subjectDid = typeof request.query.subjectDid === "string" && request.query.subjectDid.trim().length > 0
      ? request.query.subjectDid.trim()
      : undefined;

    const policies = await deps.sqlTenantProviderPolicyStore.listPolicies({ ownerSubject, subjectDid });
    reply.send({ policies });
  });

  app.post<{
    Body: {
      readonly subjectDid?: string;
      readonly providerId?: string;
      readonly providerKind?: string;
      readonly ownerSubject?: string;
      readonly shareMode?: string;
      readonly trustTier?: string;
      readonly allowedModels?: readonly string[];
      readonly maxRequestsPerMinute?: number | string;
      readonly maxConcurrentRequests?: number | string;
      readonly encryptedChannelRequired?: boolean;
      readonly warmImportThreshold?: number | string;
      readonly notes?: string;
    };
  }>("/api/ui/federation/tenant-provider-policies", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!deps.sqlTenantProviderPolicyStore) {
      reply.code(503).send({ error: "tenant_provider_policy_store_not_supported" });
      return;
    }

    const subjectDid = typeof request.body?.subjectDid === "string" ? request.body.subjectDid.trim() : "";
    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const ownerSubject = typeof request.body?.ownerSubject === "string" ? request.body.ownerSubject.trim() : "";

    if (!subjectDid || !providerId || !ownerSubject) {
      reply.code(400).send({ error: "subject_did_provider_id_and_owner_subject_required" });
      return;
    }

    const allowedModels = Array.isArray(request.body?.allowedModels)
      ? request.body.allowedModels.filter((entry): entry is string => typeof entry === "string")
      : undefined;

    const policy = await deps.sqlTenantProviderPolicyStore.upsertPolicy({
      subjectDid,
      providerId,
      providerKind: typeof request.body?.providerKind === "string"
        ? normalizeTenantProviderKind(request.body.providerKind)
        : undefined,
      ownerSubject,
      shareMode: typeof request.body?.shareMode === "string"
        ? normalizeTenantProviderShareMode(request.body.shareMode)
        : undefined,
      trustTier: typeof request.body?.trustTier === "string"
        ? normalizeTenantProviderTrustTier(request.body.trustTier)
        : undefined,
      allowedModels,
      maxRequestsPerMinute: parseOptionalPositiveInteger(request.body?.maxRequestsPerMinute),
      maxConcurrentRequests: parseOptionalPositiveInteger(request.body?.maxConcurrentRequests),
      encryptedChannelRequired: request.body?.encryptedChannelRequired,
      warmImportThreshold: parseOptionalPositiveInteger(request.body?.warmImportThreshold),
      notes: typeof request.body?.notes === "string" ? request.body.notes : undefined,
    });

    reply.code(201).send({ policy });
  });
}
