export {
  executeProviderRoutingPlan,
  inspectProviderAvailability,
} from "./attempt-executor.js";

export type {
  ErrorClassification,
  ErrorClassificationResult,
} from "./error-classifier.js";

export {
  classifyAuthError,
  classifyModelNotSupported,
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  shouldRetrySameCredentialForServerError,
  PERMANENT_DISABLE_COOLDOWN_MS,
} from "./error-classifier.js";

export {
  providerAccountsForRequest,
  reorderAccountsForLatency,
  reorderCandidatesForAffinities,
  reorderCandidatesForAffinity,
} from "./credential-selector.js";

export type { PreferredAffinity } from "./credential-selector.js";

export type { RoutingCandidate, RoutingDeps, RoutingKeyPool } from "./types.js";

export {
  clampRouteQuality,
  createAccumulator,
  emptyResult,
  successResult,
} from "./types.js";

export { buildRoutingCandidates } from "./candidate-builder.js";

export type { BuildCandidatesResult } from "./candidate-builder.js";
