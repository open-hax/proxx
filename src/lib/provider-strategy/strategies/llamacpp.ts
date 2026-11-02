import { kernels } from "../../cljs-kernels.js";

/**
 * Normalizes a model name for llama.cpp: colons become hyphens, bridging Ollama
 * style names ("gemma4:e4b") to llama.cpp `--alias` names ("gemma4-e4b").
 * The llama.cpp chat strategy is a registry entry built in CLJS.
 */
export function normalizeLlamacppModelName(model: string): string {
  return kernels.normalizeLlamacppModelName(model);
}
