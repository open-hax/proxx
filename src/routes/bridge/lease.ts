import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ProxyConfig } from "../../lib/config.js";
import type { CredentialStoreLike } from "../../lib/credential-store.js";
import type { KeyPool } from "../../lib/key-pool.js";
import { toErrorMessage } from "../../lib/provider-utils.js";
import { getResolvedAuth, authCanManageFederation } from "../shared/ui-auth.js";
import { findCredentialForFederationExport, type FederationCredentialExport } from "../federation/account-knowledge.js";

function isTrustedLocalBridgeAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function requireInternalBridge(request: FastifyRequest): boolean {
  const bridgeAuth = request.headers["x-open-hax-bridge-auth"];
  if (bridgeAuth !== "internal") {
    return false;
  }
  return isTrustedLocalBridgeAddress(request.raw.socket.remoteAddress);
}

export interface BridgeLeaseRouteDeps {
  readonly config: ProxyConfig;
  readonly keyPool: KeyPool;
  readonly credentialStore: CredentialStoreLike;
  readonly refreshOpenAiOauthAccounts?: (accountId?: string) => Promise<{
    readonly totalAccounts: number;
    readonly refreshedCount: number;
    readonly failedCount: number;
  }>;
}

type BridgeAccountDescriptor = {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: "api_key" | "oauth_bearer";
  readonly expiresAt?: number;
  readonly chatgptAccountId?: string;
  readonly planType?: string;
  readonly credentialMobility: "importable" | "access_token_only";
};

export async function registerBridgeLeaseRoutes(
  app: FastifyInstance,
  deps: BridgeLeaseRouteDeps,
): Promise<void> {
  app.get<{
    Querystring: { readonly providerId?: string; readonly limit?: string };
  }>("/api/bridge/credentials/accounts", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!requireInternalBridge(request)) {
      reply.code(403).send({ error: "bridge_internal_only" });
      return;
    }

    const providerId = typeof request.query.providerId === "string" ? request.query.providerId.trim() : "";
    if (!providerId) {
      reply.code(400).send({ error: "provider_id_required" });
      return;
    }

    const limitRaw = typeof request.query.limit === "string" ? Number.parseInt(request.query.limit, 10) : undefined;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 5000)) : 5000;

    try {
      const accounts = await deps.keyPool.getAllAccounts(providerId);
      const descriptors: BridgeAccountDescriptor[] = accounts
        .slice(0, limit)
        .map((account): BridgeAccountDescriptor => ({
          providerId: account.providerId,
          accountId: account.accountId,
          authType: account.authType,
          expiresAt: account.expiresAt,
          chatgptAccountId: account.chatgptAccountId,
          planType: account.planType,
          credentialMobility: account.authType === "oauth_bearer" ? "access_token_only" : "importable",
        }))
        .sort((a, b) => a.accountId.localeCompare(b.accountId));

      reply.send({ providerId, accounts: descriptors });
    } catch (error) {
      reply.code(502).send({ error: "bridge_accounts_failed", detail: toErrorMessage(error) });
    }
  });

  app.get("/api/bridge/credentials/providers", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!requireInternalBridge(request)) {
      reply.code(403).send({ error: "bridge_internal_only" });
      return;
    }

    try {
      const statuses = await deps.keyPool.getAllStatuses();
      const providers = Object.values(statuses)
        .map((status) => ({
          providerId: status.providerId,
          authType: status.authType,
          totalAccounts: status.totalAccounts,
          availableAccounts: status.availableAccounts,
          credentialMobility: status.authType === "oauth_bearer" ? "access_token_only" : "importable",
        }))
        .sort((a, b) => a.providerId.localeCompare(b.providerId));

      reply.send({ providers });
    } catch (error) {
      reply.code(502).send({ error: "bridge_providers_failed", detail: toErrorMessage(error) });
    }
  });

  app.post<{
    Body: { readonly providerId?: string; readonly accountId?: string };
  }>("/api/bridge/credentials/export", async (request, reply) => {
    const auth = getResolvedAuth(request as { readonly openHaxAuth?: unknown });
    if (!authCanManageFederation(auth)) {
      reply.code(auth ? 403 : 401).send({ error: auth ? "forbidden" : "unauthorized" });
      return;
    }

    if (!requireInternalBridge(request)) {
      reply.code(403).send({ error: "bridge_internal_only" });
      return;
    }

    const providerId = typeof request.body?.providerId === "string" ? request.body.providerId.trim() : "";
    const accountId = typeof request.body?.accountId === "string" ? request.body.accountId.trim() : "";
    if (!providerId || !accountId) {
      reply.code(400).send({ error: "provider_id_and_account_id_required" });
      return;
    }

    try {
      let exported = await findCredentialForFederationExport(deps.credentialStore, providerId, accountId);

      if (exported?.authType === "oauth_bearer") {
        // Refresh before exporting when we are the refresh authority and the token is near expiry.
        // This helps peers receive a usable lease (no refresh token attached).
        const now = Date.now();
        const refreshBufferMs = 10 * 60_000;
        const needsRefresh = typeof exported.expiresAt === "number"
          && Number.isFinite(exported.expiresAt)
          && exported.expiresAt <= now + refreshBufferMs;
        const hasRefreshToken = typeof exported.refreshToken === "string" && exported.refreshToken.trim().length > 0;
        const providerMatchesOpenAi = exported.providerId.trim().toLowerCase() === deps.config.openaiProviderId.trim().toLowerCase();

        if (needsRefresh && hasRefreshToken && providerMatchesOpenAi && deps.refreshOpenAiOauthAccounts) {
          await deps.refreshOpenAiOauthAccounts(exported.accountId).catch(() => undefined);
          const refreshed = await findCredentialForFederationExport(deps.credentialStore, providerId, accountId);
          if (refreshed) {
            exported = refreshed;
          }
        }
      }

      if (exported) {
        const sanitized: FederationCredentialExport = exported.authType === "oauth_bearer"
          ? { ...exported, refreshToken: undefined }
          : exported;
        reply.send({ account: sanitized });
        return;
      }

      // Fallback: export from key pool (covers env-provided api keys like REQUESTY_API_TOKEN).
      const poolAccounts = await deps.keyPool.getAllAccounts(providerId);
      const candidate = poolAccounts.find((entry) => entry.accountId === accountId);
      if (!candidate) {
        reply.code(404).send({ error: "credential_account_not_found" });
        return;
      }

      const fallbackExport: FederationCredentialExport = {
        providerId: candidate.providerId,
        accountId: candidate.accountId,
        authType: candidate.authType,
        secret: candidate.token,
        expiresAt: candidate.expiresAt,
        chatgptAccountId: candidate.chatgptAccountId,
        planType: candidate.planType,
        refreshToken: undefined,
      };

      reply.send({ account: fallbackExport });
    } catch (error) {
      reply.code(502).send({ error: "bridge_export_failed", detail: toErrorMessage(error) });
    }
  });
}
