import { getActiveCljsRuntime } from "../cljs-runtime.js";
import type { ProxyConfig } from "../config.js";
import type { ProviderRoute } from "../provider-routing.js";

interface LoggerLike {
  readonly debug: (bindings: Record<string, unknown>, message: string) => void;
  readonly warn: (bindings: Record<string, unknown>, message: string) => void;
}

interface ShadowPreviewInput {
  readonly config: Pick<ProxyConfig, "cljsPolicyManifestPath" | "cljsPolicyShadowMode">;
  readonly log: LoggerLike;
  readonly requestKind: "chat" | "responses-passthrough" | "images-passthrough";
  readonly requestedModel: string;
  readonly routedModel: string;
  readonly tenantSettings: unknown;
  readonly providerRoutes: readonly ProviderRoute[];
}

interface PreviewDecisionShape {
  readonly status?: string;
  readonly reason?: string;
  readonly providers?: readonly string[];
  readonly "route-id"?: string;
  readonly "provider-id"?: string;
}

function isPreviewDecisionShape(value: unknown): value is PreviewDecisionShape {
  return typeof value === "object" && value !== null;
}

function providerIds(routes: readonly ProviderRoute[]): readonly string[] {
  return routes.map((route) => route.providerId);
}

/**
 * Run the CLJS declarative policy preview beside existing TypeScript policy routing.
 *
 * Shadow mode is observability-only: it logs a parity summary and never mutates the live route order.
 */
export function shadowPreviewProviderPolicy(input: ShadowPreviewInput): void {
  if (input.config.cljsPolicyShadowMode !== true) {
    return;
  }

  const runtime = getActiveCljsRuntime();
  if (!runtime) {
    input.log.debug({ model: input.routedModel }, "CLJS policy shadow skipped: runtime unavailable");
    return;
  }

  const tsProviderIds = providerIds(input.providerRoutes);
  try {
    const result = runtime.previewPolicyDecision(input.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", {
      modelId: input.routedModel || input.requestedModel,
      requestKind: input.requestKind,
      tenantSettings: input.tenantSettings,
      providerIds: tsProviderIds,
    });

    if (result.status !== "ok" || !isPreviewDecisionShape(result.decision)) {
      input.log.warn({ model: input.routedModel, result }, "CLJS policy shadow preview failed");
      return;
    }

    const cljsProviderIds = result.decision.providers ?? [];
    const matches = JSON.stringify(cljsProviderIds) === JSON.stringify(tsProviderIds);
    const bindings = {
      model: input.routedModel,
      requestedModel: input.requestedModel,
      requestKind: input.requestKind,
      routeId: result.decision["route-id"],
      tsProviderIds,
      cljsProviderIds,
      cljsStatus: result.decision.status,
      cljsReason: result.decision.reason,
    };

    if (matches) {
      input.log.debug(bindings, "CLJS policy shadow provider order matches TypeScript");
    } else {
      input.log.warn(bindings, "CLJS policy shadow provider order differs from TypeScript");
    }
  } catch (error) {
    input.log.warn({ model: input.routedModel, error }, "CLJS policy shadow preview threw");
  }
}
