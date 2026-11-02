/**
 * Typed handle to the CLJS runtime's pure kernels.
 *
 * The runtime is loaded with a top-level await, so any module that imports
 * this one can call the kernels synchronously. The compiled artifact is
 * required: these functions are the implementation, not an optimization.
 *
 * The kernel surface is declared in three slices (cljs-kernels-core,
 * cljs-kernels-stores, cljs-kernels-strategy) so no file passes the 500-line
 * limit; `CljsKernels` and every type callers imported from here are unchanged.
 */
import { loadCljsRuntime } from "./cljs-runtime.js";
import type { CljsKernelsCore } from "./cljs-kernels-core.js";
import type { CljsKernelsStores } from "./cljs-kernels-stores.js";
import type { CljsKernelsStrategy } from "./cljs-kernels-strategy.js";

export type { StrategySelectionFacts } from "./cljs-kernels-core.js";
export type { OAuthManagerFacade, ChromaSearchRow, RequestLogFanout } from "./cljs-kernels-stores.js";
export type { StrategyContinueOutcome, RoutingErrorDescriptor, ExecutorState } from "./cljs-kernels-strategy.js";

export interface CljsKernels extends CljsKernelsCore, CljsKernelsStores, CljsKernelsStrategy {}

const loaded = await loadCljsRuntime({ required: true });
if (!loaded.loaded) {
  throw new Error(`CLJS runtime is required: ${loaded.reason}`);
}

export const kernels = loaded.runtime as unknown as CljsKernels;
