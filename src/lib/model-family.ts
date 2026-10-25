import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

/**
 * Requesty provider namespace for a model id, from the declarative
 * `wire-profile/requesty` route table.
 */
export const requestyModelProvider = (modelId: string): string =>
  kernels.requestyModelProvider(policyManifestPath(), modelId);
