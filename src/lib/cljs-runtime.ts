import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CljsValidationResult {
  readonly status: "ok" | "error";
  readonly record?: unknown;
  readonly errors?: unknown;
}

export interface ProxxCljsRuntime {
  readonly normalizeKeys: (value: unknown) => unknown;
  readonly validateEntity: (entityType: string, value: unknown) => CljsValidationResult;
  readonly projectPheromone: (events: readonly unknown[], opts?: unknown) => number;
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

function isProxxCljsRuntime(value: Record<string, unknown>): value is Record<string, unknown> & ProxxCljsRuntime {
  return (
    typeof value.normalizeKeys === "function" &&
    typeof value.validateEntity === "function" &&
    typeof value.projectPheromone === "function"
  );
}

function candidateModulePaths(): readonly string[] {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return [
    // Compiled TS runtime: dist/lib/cljs-runtime.js -> dist/cljs/proxx-runtime.js
    join(currentDir, "..", "cljs", moduleFileName),
    // tsx/dev runtime after `pnpm build:cljs`: src/lib/cljs-runtime.ts -> dist/cljs/proxx-runtime.js
    join(process.cwd(), "dist", "cljs", moduleFileName),
  ];
}

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
}
