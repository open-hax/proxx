import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { Sql } from "./db/index.js";
import { SqlAuthPersistence } from "./auth/sql-persistence.js";
import { SqlGitHubAllowlist } from "./auth/github-allowlist.js";
import { SqlCredentialStore } from "./db/sql-credential-store.js";
import { DEFAULT_TENANT_ID } from "./tenant-api-key.js";
import { kernels } from "./cljs-kernels.js";

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url?: string | null;
}

const {
  authorizeUrl: GITHUB_AUTHORIZE_URL,
  tokenUrl: GITHUB_TOKEN_URL,
  userUrl: GITHUB_USER_URL,
  accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
} = kernels.githubOAuthConstants();

function generateToken(): string {
  const buffer = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(buffer).toString("base64url");
}

interface OAuthRouteConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPath: string;
  readonly allowedUsers: readonly string[];
  readonly sessionSecret: string;
  readonly upstreamProviderId: string;
  readonly keysFilePath: string;
}

interface OAuthRouteDependencies {
  readonly sql: Sql;
  readonly authPersistence: SqlAuthPersistence;
  readonly allowlist: SqlGitHubAllowlist;
  readonly credentialStore: SqlCredentialStore;
}

const pendingAuths = kernels.createGithubPendingStore();

function setCookie(reply: FastifyReply, name: string, value: string, maxAge: number): void {
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  reply.header("Set-Cookie", kernels.githubSetCookieHeader(name, value, expires));
}

function clearCookie(reply: FastifyReply, name: string): void {
  reply.header("Set-Cookie", kernels.githubClearCookieHeader(name));
}

function getCookie(request: FastifyRequest, name: string): string | undefined {
  return kernels.githubCookieValue(request.headers.cookie, name, decodeURIComponent) ?? undefined;
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  config: OAuthRouteConfig,
  deps: OAuthRouteDependencies,
): Promise<void> {
  const isConfigured = config.clientId && config.clientSecret;
  if (!isConfigured) {
    app.log.info("GitHub OAuth not configured (missing GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET)");
    return;
  }

  await deps.allowlist.init();
  for (const user of config.allowedUsers) {
    await deps.allowlist.addAllowedUser(user);
  }

  app.get("/auth/login", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const redirectUri = query.redirect_uri ?? "/";

    // The PKCE verifier was never sent to GitHub; it is still drawn so the token stream is unchanged.
    generateToken();
    const state = generateToken();

    pendingAuths.add(state, redirectUri, Date.now());

    reply.redirect(`${GITHUB_AUTHORIZE_URL}?${kernels.githubAuthorizeQuery(
      config.clientId!,
      `${request.protocol}://${request.headers.host}${config.callbackPath}`,
      state,
    )}`);
  });

  app.get(config.callbackPath, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const code = query.code;
    const state = query.state;

    const queryRejection = kernels.githubCallbackRejection(query);
    if (queryRejection || !code || !state) {
      reply.code(queryRejection?.status ?? 400);
      reply.send(queryRejection?.body);
      return;
    }

    const pending = pendingAuths.take(state, Date.now());
    if (pending.rejection) {
      reply.code(pending.rejection.status);
      reply.send(pending.rejection.body);
      return;
    }

    let tokenResponse: { access_token: string; token_type: string };
    try {
      const tokenRes = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: `${request.protocol}://${request.headers.host}${config.callbackPath}`,
          state,
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
      }

      tokenResponse = (await tokenRes.json()) as { access_token: string; token_type: string };
    } catch (err) {
      reply.code(502);
      reply.send({ error: "token_exchange_failed", error_description: String(err) });
      return;
    }

    let user: GitHubUser;
    try {
      const userRes = await fetch(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      });

      if (!userRes.ok) {
        throw new Error(`GitHub user fetch failed: ${userRes.status}`);
      }

      user = (await userRes.json()) as GitHubUser;
    } catch (err) {
      reply.code(502);
      reply.send({ error: "user_fetch_failed", error_description: String(err) });
      return;
    }

    const isAllowed = await deps.allowlist.allowsUser(user.login);
    if (!isAllowed) {
      reply.code(403);
      reply.send({ error: "access_denied", error_description: `User ${user.login} is not allowed` });
      return;
    }

    const subject = kernels.githubNormalizeLogin(user.login);
    const persistedUser = await deps.credentialStore.upsertUser({
      provider: "github",
      subject,
      login: subject,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar_url ?? null,
    });
    await deps.credentialStore.ensureDefaultTenantBootstrapMembership(persistedUser.id);

    const resolvedSession = await deps.credentialStore.resolveUiSession(subject, DEFAULT_TENANT_ID);
    const tokenExtra = resolvedSession
      ? { activeTenantId: resolvedSession.activeTenantId }
      : undefined;

    const accessToken = generateToken();
    const refreshToken = generateToken();
    const now = Math.floor(Date.now() / 1000);

    await deps.authPersistence.setAccessToken({
      token: accessToken,
      clientId: "github-oauth",
      subject,
      scopes: ["read", "write"],
      extra: tokenExtra,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
    });

    await deps.authPersistence.setRefreshToken({
      token: refreshToken,
      clientId: "github-oauth",
      subject,
      scopes: ["read", "write"],
      extra: tokenExtra,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
    });

    setCookie(reply, "proxy_auth", accessToken, ACCESS_TOKEN_TTL_SECONDS);
    setCookie(reply, "proxy_refresh", refreshToken, REFRESH_TOKEN_TTL_SECONDS);

    reply.redirect(pending.redirectUri!);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const refreshToken = getCookie(request, "proxy_refresh");
    if (!refreshToken) {
      reply.code(401);
      reply.send({ error: "invalid_request", error_description: "Missing refresh token" });
      return;
    }

    const existing = await deps.authPersistence.getRefreshToken(refreshToken);
    if (!existing) {
      reply.code(401);
      reply.send({ error: "invalid_grant", error_description: "Invalid refresh token" });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (kernels.githubRefreshPlan(true, existing.expiresAt, now) === "expired") {
      await deps.authPersistence.deleteRefreshToken(refreshToken);
      reply.code(401);
      reply.send({ error: "invalid_grant", error_description: "Refresh token expired" });
      return;
    }

    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();

    await deps.authPersistence.setAccessToken({
      token: newAccessToken,
      clientId: existing.clientId,
      subject: existing.subject,
      scopes: existing.scopes,
      resource: existing.resource,
      extra: existing.extra,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
    });

    await deps.authPersistence.setRefreshToken({
      token: newRefreshToken,
      clientId: existing.clientId,
      subject: existing.subject,
      scopes: existing.scopes,
      resource: existing.resource,
      extra: existing.extra,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
    });

    await deps.authPersistence.deleteRefreshToken(refreshToken);

    setCookie(reply, "proxy_auth", newAccessToken, ACCESS_TOKEN_TTL_SECONDS);
    setCookie(reply, "proxy_refresh", newRefreshToken, REFRESH_TOKEN_TTL_SECONDS);

    reply.send({
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefreshToken,
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    const accessToken = getCookie(request, "proxy_auth");
    if (accessToken) {
      await deps.authPersistence.deleteAccessToken(accessToken);
    }

    const refreshToken = getCookie(request, "proxy_refresh");
    if (refreshToken) {
      await deps.authPersistence.deleteRefreshToken(refreshToken);
    }

    clearCookie(reply, "proxy_auth");
    clearCookie(reply, "proxy_refresh");
    reply.send({ ok: true });
  });

  app.get("/auth/me", async (request, reply) => {
    const accessToken = getCookie(request, "proxy_auth");
    if (!accessToken) {
      reply.code(401);
      reply.send({ error: "unauthorized", error_description: "Not authenticated" });
      return;
    }

    const token = await deps.authPersistence.getAccessToken(accessToken);
    if (!token) {
      reply.code(401);
      reply.send({ error: "unauthorized", error_description: "Invalid access token" });
      return;
    }

    reply.send({
      subject: token.subject,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    });
  });

  app.get("/auth/admin/accounts", async (request, reply) => {
    const accessToken = getCookie(request, "proxy_auth");
    if (!accessToken) {
      reply.code(401);
      reply.send({ error: "unauthorized" });
      return;
    }

    const token = await deps.authPersistence.getAccessToken(accessToken);
    if (!token) {
      reply.code(401);
      reply.send({ error: "unauthorized" });
      return;
    }

    const accounts = await deps.credentialStore.getAllAccounts();
    const result: Record<string, unknown[]> = {};
    for (const [providerId, creds] of accounts) {
      result[providerId] = creds.map((c) => kernels.githubAdminAccountView({
        accountId: c.accountId,
        authType: c.authType,
        refreshToken: c.refreshToken,
        expiresAt: c.expiresAt,
      }));
    }

    reply.send(result);
  });

  app.get("/auth/admin/allowlist", async (_request, reply) => {
    const users = await deps.allowlist.getAllowedUsers();
    reply.send({ users });
  });

  app.post<{ Body: { readonly login?: string } }>("/auth/admin/allowlist", async (request, reply) => {
    const rawLogin = request.body?.login;
    const login = rawLogin === undefined || rawLogin === null ? undefined : kernels.githubNormalizeLogin(rawLogin);
    if (!login) {
      reply.code(400);
      reply.send({ error: "login_required" });
      return;
    }

    await deps.allowlist.addAllowedUser(login);
    reply.send({ ok: true, login });
  });

  app.delete<{ Body: { readonly login?: string } }>("/auth/admin/allowlist", async (request, reply) => {
    const rawLogin = request.body?.login;
    const login = rawLogin === undefined || rawLogin === null ? undefined : kernels.githubNormalizeLogin(rawLogin);
    if (!login) {
      reply.code(400);
      reply.send({ error: "login_required" });
      return;
    }

    await deps.allowlist.removeAllowedUser(login);
    reply.send({ ok: true, login });
  });
}

export function createVerifyBearerToken(deps: OAuthRouteDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const token = kernels.githubBearer(request.headers.authorization);
    if (token !== null) {
      const stored = await deps.authPersistence.getAccessToken(token);
      if (stored) {
        return true;
      }
    }

    const cookieToken = getCookie(request, "proxy_auth");
    if (cookieToken) {
      const stored = await deps.authPersistence.getAccessToken(cookieToken);
      if (stored) {
        return true;
      }
    }

    reply.code(401);
    reply.send({ error: "unauthorized", error_description: "Invalid or missing access token" });
    return false;
  };
}
