import { getActiveCljsRuntime } from "../cljs-runtime.js";
import type { ProxyConfig } from "../config.js";
import type { ProviderRoute } from "../provider-routing.js";

interface LoggerLike {
  readonly debug: (bindings: Record<string, unknown>, message: string) => void;
  readonly warn: (bindings: Record<string, unknown>, message: string) => void;
}

type CljsPolicyConfig = Pick<ProxyConfig, "cljsPolicyManifestPath" | "cljsPolicyShadowMode" | "cljsPolicyAuthoritative">;

interface CljsProviderPolicyInput {
  readonly config: CljsPolicyConfig;
  readonly log: LoggerLike;
  readonly requestKind: "chat" | "responses-passthrough" | "images-passthrough" | "embeddings";
  readonly requestedModel: string;
  readonly routedModel: string;
  readonly tenantSettings: unknown;
  readonly providerRoutes: readonly ProviderRoute[];
  readonly policyEvidence?: unknown;
}

interface PreviewDecisionProviderRoute {
  readonly providerId?: string;
  readonly provider_id?: string;
  readonly "provider-id"?: string;
  readonly baseUrl?: string;
  readonly base_url?: string;
  readonly "base-url"?: string;
}

interface PreviewDecisionShape {
  readonly status?: string;
  readonly reason?: string;
  readonly providers?: readonly string[];
  readonly "provider-routes"?: readonly PreviewDecisionProviderRoute[];
  readonly providerRoutes?: readonly PreviewDecisionProviderRoute[];
  readonly "route-id"?: string;
  readonly "provider-id"?: string;
}

function isPreviewDecisionShape(value: unknown): value is PreviewDecisionShape {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function providerIds(routes: readonly ProviderRoute[]): readonly string[] {
  return routes.map((route) => route.providerId);
}

function providerRoutesFromDecision(decision: PreviewDecisionShape | undefined): ProviderRoute[] {
  const rawRoutes = decision?.["provider-routes"] ?? decision?.providerRoutes ?? [];
  return rawRoutes.flatMap((route) => {
    const providerId = (route.providerId ?? route.provider_id ?? route["provider-id"] ?? "").trim();
    const baseUrl = (route.baseUrl ?? route.base_url ?? route["base-url"] ?? "").trim().replace(/\/+$/, "");
    return providerId && baseUrl ? [{ providerId, baseUrl }] : [];
  });
}

function candidateProviderRoutes(input: CljsProviderPolicyInput): ProviderRoute[] {
  if (input.config.cljsPolicyAuthoritative === true) {
    return [];
  }
  return [...input.providerRoutes];
}

function orderRoutesFromPolicy(routes: readonly ProviderRoute[], policyProviderIds: readonly string[]): ProviderRoute[] {
  const byProviderId = new Map(routes.map((route) => [route.providerId, route]));
  return policyProviderIds.flatMap((providerId) => {
    const route = byProviderId.get(providerId);
    return route ? [route] : [];
  });
}

function previewProviderPolicy(input: CljsProviderPolicyInput): PreviewDecisionShape | undefined {
  const runtime = getActiveCljsRuntime();
  if (!runtime) {
    const bindings = { model: input.routedModel };
    if (input.config.cljsPolicyAuthoritative === true) {
      input.log.warn(bindings, "CLJS policy authoritative routing failed closed: runtime unavailable");
    } else {
      input.log.debug(bindings, "CLJS policy shadow skipped: runtime unavailable");
    }
    return undefined;
  }

  const candidateRoutes = candidateProviderRoutes(input);
  const inputProviderIds = providerIds(candidateRoutes);
  const result = runtime.previewPolicyDecision(input.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", {
    modelId: input.routedModel || input.requestedModel,
    requestKind: input.requestKind,
    tenantSettings: input.tenantSettings,
    providerIds: inputProviderIds,
    ...(isRecord(input.policyEvidence) ? input.policyEvidence : {}),
  });

  if (result.status !== "ok" || !isPreviewDecisionShape(result.decision)) {
    input.log.warn({ model: input.routedModel, result }, "CLJS policy preview failed");
    return undefined;
  }

  const cljsProviderIds = result.decision.providers ?? [];
  const matches = JSON.stringify(cljsProviderIds) === JSON.stringify(inputProviderIds);
  const bindings = {
    model: input.routedModel,
    requestedModel: input.requestedModel,
    requestKind: input.requestKind,
    routeId: result.decision["route-id"],
    inputProviderIds,
    cljsProviderIds,
    cljsStatus: result.decision.status,
    cljsReason: result.decision.reason,
  };

  if (matches) {
    input.log.debug(bindings, "CLJS policy provider order matches input candidates");
  } else {
    input.log.warn(bindings, "CLJS policy provider order differs from input candidates");
  }

  return result.decision;
}

/**
 * Run the CLJS declarative policy beside existing TypeScript policy routing.
 *
 * In shadow mode this logs only. In authoritative mode this returns the CLJS-selected provider route order,
 * filtering out providers the CLJS policy did not select. If authoritative preview cannot produce a decision,
 * it fails closed by returning an empty route list.
 */
export function applyCljsProviderPolicy(input: CljsProviderPolicyInput): ProviderRoute[] {
  const enabled = input.config.cljsPolicyShadowMode === true || input.config.cljsPolicyAuthoritative === true;
  if (!enabled) {
    return [...input.providerRoutes];
  }

  try {
    const decision = previewProviderPolicy(input);
    if (input.config.cljsPolicyAuthoritative !== true) {
      return [...input.providerRoutes];
    }

    if (!decision || decision.status !== "ok") {
      input.log.warn({ model: input.routedModel, decision }, "CLJS policy authoritative routing exhausted");
      return [];
    }

    const decisionProviderIds = decision.providers ?? [];
    const orderedRoutes = orderRoutesFromPolicy(providerRoutesFromDecision(decision), decisionProviderIds);
    if (orderedRoutes.length !== decisionProviderIds.length) {
      input.log.warn({
        model: input.routedModel,
        routeId: decision["route-id"],
        providerIds: decisionProviderIds,
        providerRouteIds: orderedRoutes.map((route) => route.providerId),
      }, "CLJS policy authoritative routing missing provider route facts");
      return [];
    }
    input.log.debug({
      model: input.routedModel,
      routeId: decision["route-id"],
      providerIds: orderedRoutes.map((route) => route.providerId),
    }, "CLJS policy authoritative provider order applied");
    return orderedRoutes;
  } catch (error) {
    input.log.warn({ model: input.routedModel, error }, "CLJS policy preview threw");
    return input.config.cljsPolicyAuthoritative === true ? [] : [...input.providerRoutes];
  }
}

/** Backwards-compatible shadow-only wrapper for tests and callers that only want observability. */
export function shadowPreviewProviderPolicy(input: CljsProviderPolicyInput): void {
  applyCljsProviderPolicy({
    ...input,
    config: { ...input.config, cljsPolicyAuthoritative: false },
  });
}
