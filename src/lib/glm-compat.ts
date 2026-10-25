/**
 * GLM request compatibility. The rewrite rules are pure CLJS (`proxx.compat.glm`);
 * GLM model recognition is the `:model-family/glm` policy contract.
 */
import { kernels } from "./cljs-kernels.js";

export const isGlmModel = (model: string): boolean => kernels.isGlmModel(model);

export const applyGlmThinking = (body: Record<string, unknown>, model?: string): Record<string, unknown> =>
  kernels.applyGlmThinking(body, model);
