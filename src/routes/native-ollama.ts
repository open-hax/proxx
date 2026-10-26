import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../lib/app-deps.js";
import { kernels } from "../lib/cljs-kernels.js";

/**
 * Ollama-native /api/* routes. Each translates the native request to an OpenAI
 * request, injects it into the app and translates the answer back; the routes
 * and their decisions live in CLJS (proxx.http.native-ollama).
 */
export function registerNativeOllamaRoutes(deps: AppDeps, app: FastifyInstance): void {
  kernels.registerNativeOllamaRoutes(app, deps);
}
