import { readFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

function defaultAuthV2FilePath(): string {
  return process.env.FACTORY_AUTH_V2_FILE ?? join(homedir(), ".factory", "auth.v2.file");
}

function defaultAuthV2KeyPath(): string {
  return process.env.FACTORY_AUTH_V2_KEY ?? join(homedir(), ".factory", "auth.v2.key");
}

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
  const key = Buffer.from(keyBase64.trim(), "base64");
  const parts = encryptedContent.trim().split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid auth.v2.file format: expected base64(iv):base64(authTag):base64(ciphertext)");
  }

  const iv = Buffer.from(parts[0]!, "base64");
  const authTag = Buffer.from(parts[1]!, "base64");
  const ciphertext = Buffer.from(parts[2]!, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed: unknown = JSON.parse(decrypted.toString("utf-8"));

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Decrypted auth.v2 content is not a valid JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record["access_token"] === "string" ? record["access_token"].trim() : "";
  const refreshToken = typeof record["refresh_token"] === "string" ? record["refresh_token"].trim() : "";

  if (accessToken.length === 0) {
    throw new Error("Decrypted auth.v2 content is missing access_token");
  }

  return { accessToken, refreshToken };
}

/**
 * Attempt to load Factory OAuth credentials from ~/.factory/auth.v2.file + auth.v2.key.
 * Returns null if files are missing or credentials are invalid.
 * Logs warnings on errors but never throws.
 */
export async function loadFactoryAuthV2(): Promise<FactoryAuthV2Credentials | null> {
  const authV2File = defaultAuthV2FilePath();
  const authV2Key = defaultAuthV2KeyPath();

  try {
    const [keyContent, encryptedContent] = await Promise.all([
      readFile(authV2Key, "utf-8"),
      readFile(authV2File, "utf-8"),
    ]);

    const credentials = decryptAuthV2(keyContent, encryptedContent);
    return credentials;
  } catch (error) {
    const isFileNotFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (isFileNotFound) {
      // Files simply don't exist — not an error, just no OAuth credentials
      return null;
    }

    console.warn(
      `[factory-auth] Failed to load Factory OAuth credentials from ${authV2File}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse JWT expiry from an access token (base64url decode the middle segment).
 * Returns epoch milliseconds or null if the token is not a valid JWT.
 */
export function parseJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && "exp" in parsed) {
      const exp = (parsed as Record<string, unknown>)["exp"];
      if (typeof exp === "number" && Number.isFinite(exp)) {
        return exp * 1000; // Convert seconds to milliseconds
      }
    }
  } catch {
    // Not a valid JWT
  }

  return null;
}
