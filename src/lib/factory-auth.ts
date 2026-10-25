import type { ProviderCredential } from "./key-pool.js";
import { kernels } from "./cljs-kernels.js";

/**
 * Factory auth. The auth.v2 envelope checks, JWT expiry decoding, refresh
 * decision and WorkOS response validation are CLJS (`proxx.oauth.factory`);
 * file, crypto and HTTP effects are its edge (`proxx.runtime.factory-auth`).
 */

export interface FactoryAuthV2Credentials {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * Decrypt Factory auth.v2 credentials.
 *
 * Format of auth.v2.file: base64(iv):base64(authTag):base64(ciphertext)
 * Format of auth.v2.key: base64-encoded AES-256-GCM key
 * Decrypted JSON: { access_token, refresh_token }
 */
export function decryptAuthV2(keyBase64: string, encryptedContent: string): FactoryAuthV2Credentials {
  return kernels.decryptAuthV2(keyBase64, encryptedContent);
}

/**
 * Attempt to load Factory OAuth credentials from ~/.factory/auth.v2.file + auth.v2.key.
 * Returns null if files are missing or credentials are invalid.
 * Logs warnings on errors but never throws.
 */
export function loadFactoryAuthV2(): Promise<FactoryAuthV2Credentials | null> {
  return kernels.loadFactoryAuthV2();
}

/**
 * Parse JWT expiry from an access token (base64url decode the middle segment).
 * Returns epoch milliseconds or null if the token is not a valid JWT.
 */
export function parseJwtExpiry(token: string): number | null {
  return kernels.parseJwtExpiry(token);
}

/** Buffer before JWT expiry to trigger proactive refresh (30 minutes). */
export const FACTORY_REFRESH_BUFFER_MS: number = kernels.factoryRefreshBufferMs;

export interface FactoryRefreshedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number | undefined;
}

/**
 * Check whether a Factory OAuth credential needs a proactive token refresh.
 * Returns true when the JWT exp claim is within 30 minutes of current time,
 * or when expiresAt is missing but the credential has a refresh token.
 */
export function factoryCredentialNeedsRefresh(credential: ProviderCredential): boolean {
  return kernels.factoryCredentialNeedsRefresh(credential);
}

/**
 * Refresh a Factory OAuth token via the WorkOS API.
 *
 * POST https://api.workos.com/user_management/authenticate
 * Body (URL-encoded form): grant_type=refresh_token&refresh_token={token}&client_id={clientId}
 *
 * Returns the new access token, refresh token, and parsed JWT expiry.
 */
export function refreshFactoryOAuthToken(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<FactoryRefreshedTokens> {
  return kernels.refreshFactoryOAuthToken(refreshToken, fetchFn);
}

/**
 * Encrypt Factory auth.v2 credentials using AES-256-GCM.
 * Returns string in format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encryptAuthV2(keyBase64: string, data: { readonly access_token: string; readonly refresh_token: string }): string {
  return kernels.encryptAuthV2(keyBase64, data);
}

/**
 * Persist refreshed Factory OAuth tokens back to the encrypted auth.v2 file.
 * Only writes if the auth.v2.key file exists and is readable.
 * Never throws — logs warnings on failure.
 */
export function persistFactoryAuthV2(accessToken: string, refreshToken: string): Promise<void> {
  return kernels.persistFactoryAuthV2(accessToken, refreshToken);
}
