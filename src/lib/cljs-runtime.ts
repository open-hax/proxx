import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CljsValidationResult {
  readonly status: "ok" | "error";
  readonly record?: unknown;
  readonly errors?: unknown;
}

export interface CljsPolicyRouteResult {
  readonly status: "ok" | "error";
  readonly result?: unknown;
  readonly trace?: readonly unknown[];
  readonly error?: string;
  readonly data?: unknown;
}

export interface ProxxCljsRuntime {
  readonly normalizeKeys: (value: unknown) => unknown;
  readonly validateEntity: (entityType: string, value: unknown) => CljsValidationResult;
  readonly projectPheromone: (events: readonly unknown[], opts?: unknown) => number;
  readonly routePolicy: (policies: readonly unknown[], ctx: unknown) => CljsPolicyRouteResult;
}

export type CljsRuntimeLoadResult =
  | {
      readonly loaded: true;
      readonly modulePath: string;
      readonly runtime: ProxxCljsRuntime;
    }
  | {
      readonly loaded: false;
      readonly reason: string;
    };

interface LoadOptions {
  readonly required?: boolean;
}

const moduleFileName = "proxx-runtime.js";

/**
 * Determines whether an object implements the Proxx CLJS runtime API.
 *
 * @param value - Candidate module object to inspect
 * @returns `true` if `value` exposes the expected CLJS runtime functions; `false` otherwise.
 */
function isProxxCljsRuntime(value: Record<string, unknown>): value is Record<string, unknown> & ProxxCljsRuntime {
  return (
    typeof value.normalizeKeys === "function" &&
    typeof value.validateEntity === "function" &&
    typeof value.projectPheromone === "function" &&
    typeof value.routePolicy === "function"
  );
}

/**
 * Produces an ordered list of candidate filesystem paths where the CLJS runtime artifact may be located.
 *
 * @returns An array of absolute file paths to probe for the runtime, ordered by preference.
 */
function candidateModulePaths(): readonly string[] {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return [
    // Compiled TS runtime: dist/lib/cljs-runtime.js -> dist/cljs/proxx-runtime.js
    join(currentDir, "..", "cljs", moduleFileName),
    // tsx/dev runtime after `pnpm build:cljs`: src/lib/cljs-runtime.ts -> dist/cljs/proxx-runtime.js
    join(process.cwd(), "dist", "cljs", moduleFileName),
  ];
}

/**
 * Attempts to locate, import, and validate the CLJS runtime artifact from known candidate paths.
 *
 * Tries each candidate file path in turn, recording failures; on the first module that exports the expected
 * runtime API returns its path and runtime object. If no candidate is usable and `options.required` is true,
 * an Error is thrown containing the failure details; otherwise a `{ loaded: false, reason }` result is returned.
 *
 * @param options - Optional load settings. If `options.required` is `true`, a missing or invalid runtime will cause an exception.
 * @returns When successful: `{ loaded: true, modulePath, runtime }`. When not found: `{ loaded: false, reason }`.
 * @throws Error when `options.required` is `true` and no valid runtime could be loaded; the error message includes attempted paths and failure details.
 */
export async function loadCljsRuntime(options: LoadOptions = {}): Promise<CljsRuntimeLoadResult> {
  const attempted: string[] = [];
  const failures: string[] = [];

  for (const modulePath of candidateModulePaths()) {
    attempted.push(modulePath);
    try {
      await access(modulePath);
      const moduleUrl = pathToFileURL(modulePath).href;
      const imported = (await import(moduleUrl)) as Record<string, unknown>;
      if (!isProxxCljsRuntime(imported)) {
        throw new Error(`CLJS module ${modulePath} did not expose the expected runtime API`);
      }

      return {
        loaded: true,
        modulePath,
        runtime: imported,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${modulePath}: ${message}`);
    }
  }

  const reason = `CLJS runtime artifact not found; attempted ${attempted.join(", ")}`;
  if (options.required === true) {
    throw new Error(`${reason}; failures: ${failures.join("; ")}`);
  }

  return {
    loaded: false,
    reason,
  };
}

let activeCljsRuntime: ProxxCljsRuntime | undefined;

/**
 * Set the module's active CLJS runtime used by helper functions.
 *
 * @param runtime - The CLJS runtime to register, or `undefined` to clear the active runtime
 */
export function setActiveCljsRuntime(runtime: ProxxCljsRuntime | undefined): void {
  activeCljsRuntime = runtime;
}

/**
 * Retrieve the currently active CLJS runtime instance.
 *
 * @returns The active Proxx CLJS runtime instance, or `undefined` if no runtime is set
 */
export function getActiveCljsRuntime(): ProxxCljsRuntime | undefined {
  return activeCljsRuntime;
}

/**
 * Normalize object keys using the active CLJS runtime when available.
 *
 * @param value - The value whose object keys should be normalized
 * @returns The value with normalized keys when a CLJS runtime is active, otherwise the original `value`
 */
export function normalizeObjectKeysWithCljs<T>(value: T): T | unknown {
  return activeCljsRuntime?.normalizeKeys(value) ?? value;
}

/**
 * Performs smoke checks of a Proxx CLJS runtime to verify the required API behaviour.
 *
 * @param runtime - The runtime implementation to validate.
 * @throws Error - If `runtime.normalizeKeys` does not return an object containing the keys `"provider-id"` and `"nested-value"`.
 * @throws Error - If `runtime.validateEntity("provider", ...)` returns a validation result whose `status` is not `"ok"`.
 * @throws Error - If `runtime.projectPheromone(...)` does not return a finite number greater than `0`.
 * @throws Error - If `runtime.routePolicy(...)` cannot evaluate a minimal policy tree.
 */
export async function assertCljsRuntimeReady(runtime: ProxxCljsRuntime): Promise<void> {
  const normalized = runtime.normalizeKeys({ providerId: "openai", nested_value: { modelId: "gpt-4o" } });
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    !("provider-id" in normalized) ||
    !("nested-value" in normalized)
  ) {
    throw new Error("CLJS runtime normalizeKeys readiness check failed");
  }

  const validation = runtime.validateEntity("provider", {
    id: "runtime-smoke",
    displayName: "Runtime Smoke",
    enabled: true,
  });
  if (validation.status !== "ok") {
    throw new Error("CLJS runtime validateEntity readiness check failed");
  }

  const score = runtime.projectPheromone([{ ts: Date.now(), outcome: "success" }], {});
  if (!Number.isFinite(score) || score <= 0) {
    throw new Error("CLJS runtime projectPheromone readiness check failed");
  }

  const routeResult = runtime.routePolicy([
    {
      "contract/id": "runtime/root",
      "contract/kind": "policy",
      "policy/outcome": "next",
    },
  ], {});
  if (routeResult.status !== "error") {
    throw new Error("CLJS runtime routePolicy readiness check failed");
  }
}
