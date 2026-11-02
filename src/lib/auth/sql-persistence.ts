import type { Sql } from "../db/index.js";
import { kernels } from "../cljs-kernels.js";
import type { AuthSession, AccessToken, RefreshToken, OAuthClient } from "./types.js";

interface SqlAuthPersistenceKernel {
  init(): Promise<void>;
  getSession(id: string): Promise<AuthSession | undefined>;
  setSession(session: AuthSession): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getAccessToken(token: string): Promise<AccessToken | undefined>;
  setAccessToken(token: AccessToken): Promise<void>;
  deleteAccessToken(token: string): Promise<void>;
  updateAccessTokenExtra(token: string, extra?: Record<string, unknown>): Promise<boolean>;
  getRefreshToken(token: string): Promise<RefreshToken | undefined>;
  setRefreshToken(token: RefreshToken): Promise<void>;
  deleteRefreshToken(token: string): Promise<void>;
  updateRefreshTokenExtra(token: string, extra?: Record<string, unknown>): Promise<boolean>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  setClient(client: OAuthClient): Promise<void>;
  cleanup(): Promise<number>;
}

/**
 * OAuth sessions, tokens and clients in Postgres. The statements and the row
 * views are proxx.auth.persistence; proxx.runtime.auth-persistence runs them.
 * This class keeps the names and types callers already use.
 */
export class SqlAuthPersistence {
  private readonly impl: SqlAuthPersistenceKernel;

  public constructor(sql: Sql) {
    this.impl = kernels.createSqlAuthPersistence(sql) as SqlAuthPersistenceKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public getSession(id: string): Promise<AuthSession | undefined> {
    return this.impl.getSession(id);
  }

  public setSession(session: AuthSession): Promise<void> {
    return this.impl.setSession(session);
  }

  public deleteSession(id: string): Promise<void> {
    return this.impl.deleteSession(id);
  }

  public getAccessToken(token: string): Promise<AccessToken | undefined> {
    return this.impl.getAccessToken(token);
  }

  public setAccessToken(token: AccessToken): Promise<void> {
    return this.impl.setAccessToken(token);
  }

  public deleteAccessToken(token: string): Promise<void> {
    return this.impl.deleteAccessToken(token);
  }

  public updateAccessTokenExtra(token: string, extra?: Record<string, unknown>): Promise<boolean> {
    return this.impl.updateAccessTokenExtra(token, extra);
  }

  public getRefreshToken(token: string): Promise<RefreshToken | undefined> {
    return this.impl.getRefreshToken(token);
  }

  public setRefreshToken(token: RefreshToken): Promise<void> {
    return this.impl.setRefreshToken(token);
  }

  public deleteRefreshToken(token: string): Promise<void> {
    return this.impl.deleteRefreshToken(token);
  }

  public updateRefreshTokenExtra(token: string, extra?: Record<string, unknown>): Promise<boolean> {
    return this.impl.updateRefreshTokenExtra(token, extra);
  }

  public getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.impl.getClient(clientId);
  }

  public setClient(client: OAuthClient): Promise<void> {
    return this.impl.setClient(client);
  }

  public cleanup(): Promise<number> {
    return this.impl.cleanup();
  }
}
