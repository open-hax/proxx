import type { ProviderCredential } from "../../key-pool.js";
import { kernels } from "../../cljs-kernels.js";
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
  return kernels.classifyAuthError(credential, providerId, status, configCooldownMs) as ErrorClassificationResult;
}

export function classifyModelNotSupported(
  configCooldownMs: number,
): ErrorClassificationResult {
  return kernels.classifyModelNotSupported(configCooldownMs) as ErrorClassificationResult;
}
