import type { ProviderCredential } from "../../key-pool.js";
import {
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  shouldRetrySameCredentialForServerError,
  PERMANENT_DISABLE_COOLDOWN_MS,
} from "../shared.js";

export type ErrorClassification =
  | "transient"
  | "rate_limit"
  | "auth_cooldown"
  | "auth_permanent_disable"
  | "model_not_found"
  | "model_not_supported"
  | "bad_request";

export interface ErrorClassificationResult {
  readonly classification: ErrorClassification;
  readonly cooldownMs?: number;
}

export {
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  shouldRetrySameCredentialForServerError,
  PERMANENT_DISABLE_COOLDOWN_MS,
};

export function classifyAuthError(
  credential: ProviderCredential,
  providerId: string,
  status: number,
  configCooldownMs: number,
): ErrorClassificationResult {
  if (shouldPermanentlyDisableCredential(credential, status)) {
    return { classification: "auth_permanent_disable", cooldownMs: PERMANENT_DISABLE_COOLDOWN_MS };
  }
  if (shouldCooldownCredentialOnAuthFailure(providerId, status)) {
    return { classification: "auth_cooldown", cooldownMs: Math.min(configCooldownMs, 10_000) };
  }
  return { classification: "transient" };
}

export function classifyModelNotSupported(
  configCooldownMs: number,
): ErrorClassificationResult {
  return { classification: "model_not_supported", cooldownMs: Math.min(configCooldownMs, 60_000) };
}
