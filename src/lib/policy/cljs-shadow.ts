import { getActiveCljsRuntime } from "../cljs-runtime.js";
import type { ProxyConfig } from "../config.js";
import type { ProviderRoute } from "../provider-routing.js";

interface LoggerLike {
  readonly debug: (bindings: Record<string, unknown>, message: string) => void;
  readonly warn: (bindings: Record<string, unknown>, message: string) => void;
}

type CljsPolicyConfig = Pick<ProxyConfig,
  | "cljsPolicyManifestPath"
  | "cljsPolicyShadowMode"
  | "cljsPolicyAuthoritative"
> & Partial<Pick<ProxyConfig,
  | "openaiProviderId"
  | "openaiBaseUrl"
  | "upstreamProviderBaseUrls"
  | "openaiResponsesPath"
  | "openaiChatCompletionsPath"
>>;

interface CljsProviderPolicyInput {
  readonly config: CljsPolicyConfig;
  readonly log: LoggerLike;
  readonly requestKind: "chat" | "responses-passthrough" | "images-passthrough" | "embeddings";
  readonly requestedModel: string;
  readonly routedModel: string;
  readonly tenantSettings: {
    readonly allowedModels?: readonly string[] | null;
    readonly allowedProviderIds?: readonly string[] | null;
    readonly disabledProviderIds?: readonly string[] | null;
  };
  readonly providerRoutes: readonly ProviderRoute[];
  readonly catalogBundle?: unknown;
  readonly catalogAvailability?: boolean;
  readonly policyEvidence?: unknown;
  readonly strategies?: unknown;
  readonly strategiesByProvider?: unknown;
}

interface CljsProviderPolicyResult {
  readonly providerRoutes: ProviderRoute[];
  readonly decision?: PreviewDecisionShape;
  readonly catalog?: {
    readonly disabled?: boolean;
    readonly rejected?: boolean;
  };
}

interface PreviewDecisionProviderRoute {
  readonly providerId?: string;
  readonly provider_id?: string;
  readonly "provider-id"?: string;
  readonly baseUrl?: string;
  readonly base_url?: string;
  readonly "base-url"?: string;
  readonly authRequired?: boolean;
  readonly auth_required?: boolean;
  readonly "auth-required"?: boolean;
  readonly "auth-required?"?: boolean;
  readonly "auth/required?"?: boolean;
}

interface PreviewDecisionShape {
  readonly status?: string;
  readonly reason?: string;
  readonly providers?: readonly string[];
  readonly "provider-routes"?: readonly PreviewDecisionProviderRoute[];
  readonly providerRoutes?: readonly PreviewDecisionProviderRoute[];
  readonly "route-id"?: string;
  readonly "provider-id"?: string;
  readonly strategy?: { readonly mode?: string } | string;
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

function providerRoutesFromRaw(rawRoutes: unknown): ProviderRoute[] | undefined {
  if (!Array.isArray(rawRoutes)) {
    return undefined;
  }

  return rawRoutes.flatMap((rawRoute) => {
    if (!isRecord(rawRoute)) {
      return [];
    }

    const providerId = String(rawRoute.providerId ?? rawRoute.provider_id ?? rawRoute["provider-id"] ?? "").trim();
    const baseUrl = String(rawRoute.baseUrl ?? rawRoute.base_url ?? rawRoute["base-url"] ?? "").trim().replace(/\/+$/, "");
    const authRequired = rawRoute.authRequired
      ?? rawRoute.auth_required
      ?? rawRoute["auth-required"]
      ?? rawRoute["auth-required?"]
      ?? rawRoute["auth/required?"];

    let paths: Record<string, string> | undefined;
    const rawPaths = rawRoute.paths ?? rawRoute["paths"];
    if (isRecord(rawPaths)) {
      paths = {};
      for (const [key, value] of Object.entries(rawPaths)) {
        if (typeof value === "string" && value.trim().length > 0) {
          paths[key] = value.trim();
        }
      }
      if (Object.keys(paths).length === 0) {
        paths = undefined;
      }
    }

    return providerId && baseUrl
      ? [{ providerId, baseUrl, ...(typeof authRequired === "boolean" ? { authRequired } : {}), ...(paths ? { paths } : {}) }]
      : [];
  });
}

function providerRoutesFromDecision(decision: PreviewDecisionShape | undefined): ProviderRoute[] {
  return providerRoutesFromRaw(decision?.["provider-routes"] ?? decision?.providerRoutes ?? []) ?? [];
}

export function filterProviderRoutesWithCljs(input: CljsProviderPolicyInput): CljsProviderPolicyResult {
  const runtime = getActiveCljsRuntime();
  if (!runtime?.filterProviderRoutes) {
    return { providerRoutes: [...input.providerRoutes] };
  }

  const result = runtime.filterProviderRoutes(input.config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", {
    config: input.config,
    modelId: input.routedModel || input.requestedModel,
    requestKind: input.requestKind,
    tenantSettings: input.tenantSettings,
    providerRoutes: input.providerRoutes,
    ...(typeof input.catalogBundle !== "undefined" ? { catalogBundle: input.catalogBundle } : {}),
    ...(typeof input.catalogAvailability !== "undefined" ? { catalogAvailability: input.catalogAvailability } : {}),
  });
  if (result.status !== "ok") {
    input.log.warn({ model: input.routedModel, result }, "CLJS provider route filtering failed");
    return { providerRoutes: [...input.providerRoutes] };
  }

  const providerRoutes = providerRoutesFromRaw(result.providerRoutes ?? result["provider-routes"]);
  return {
    providerRoutes: providerRoutes ?? [...input.providerRoutes],
    catalog: result.catalog,
  };
}

function candidateProviderRoutes(input: CljsProviderPolicyInput): ProviderRoute[] {
  if (input.config.cljsPolicyAuthoritative === true) {
    return [];
  }
  return [...input.providerRoutes];
}

function concreteRouteFromConfig(config: CljsPolicyConfig, providerId: string): ProviderRoute | undefined {
  const baseUrl = (providerId === config.openaiProviderId
    ? config.openaiBaseUrl ?? ""
    : config.upstreamProviderBaseUrls?.[providerId] ?? "")
    .trim()
    .replace(/\/+$/, "");
  return baseUrl.length > 0 ? { providerId, baseUrl } : undefined;
}

function orderRoutesFromPolicy(config: CljsPolicyConfig, routes: readonly ProviderRoute[], policyProviderIds: readonly string[]): ProviderRoute[] {
  const byProviderId = new Map(routes.map((route) => [route.providerId, route]));
  return policyProviderIds.flatMap((providerId) => {
    const route = byProviderId.get(providerId) ?? concreteRouteFromConfig(config, providerId);
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
    ...(typeof input.strategies !== "undefined" ? { strategies: input.strategies } : {}),
    ...(typeof input.strategiesByProvider !== "undefined" ? { strategiesByProvider: input.strategiesByProvider } : {}),
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
export function applyCljsProviderPolicyWithDecision(input: CljsProviderPolicyInput): CljsProviderPolicyResult {
  const cljsFiltered = filterProviderRoutesWithCljs(input);
  const eligibleInput: CljsProviderPolicyInput = {
    ...input,
    providerRoutes: cljsFiltered.providerRoutes,
  };
  const enabled = eligibleInput.config.cljsPolicyShadowMode === true || eligibleInput.config.cljsPolicyAuthoritative === true;
  if (!enabled) {
    return { providerRoutes: [...eligibleInput.providerRoutes], catalog: cljsFiltered.catalog };
  }

  try {
    const decision = previewProviderPolicy(eligibleInput);
    if (eligibleInput.config.cljsPolicyAuthoritative !== true) {
      if (eligibleInput.requestedModel.trim().toLowerCase().startsWith("auto:")) {
        return { providerRoutes: [...eligibleInput.providerRoutes], decision, catalog: cljsFiltered.catalog };
      }
      const decisionProviderIds = decision?.providers ?? [];
      const orderedRoutes = decision?.status === "ok"
        ? orderRoutesFromPolicy(eligibleInput.config, eligibleInput.providerRoutes, decisionProviderIds)
        : [];
      return {
        providerRoutes: orderedRoutes.length > 0 ? orderedRoutes : [...eligibleInput.providerRoutes],
        decision,
        catalog: cljsFiltered.catalog,
      };
    }

    if (!decision || decision.status !== "ok") {
      eligibleInput.log.warn({ model: eligibleInput.routedModel, decision }, "CLJS policy authoritative routing exhausted");
      return { providerRoutes: [], decision, catalog: cljsFiltered.catalog };
    }

    const decisionProviderIds = decision.providers ?? [];
    const orderedRoutes = orderRoutesFromPolicy(eligibleInput.config, eligibleInput.providerRoutes, decisionProviderIds);
    if (orderedRoutes.length !== decisionProviderIds.length) {
      eligibleInput.log.warn({
        model: eligibleInput.routedModel,
        routeId: decision["route-id"],
        providerIds: decisionProviderIds,
        providerRouteIds: orderedRoutes.map((route) => route.providerId),
      }, "CLJS policy authoritative routing selected providers without concrete route facts");
    }
    if (orderedRoutes.length === 0) {
      return { providerRoutes: [], decision, catalog: cljsFiltered.catalog };
    }
    eligibleInput.log.debug({
      model: eligibleInput.routedModel,
      routeId: decision["route-id"],
      providerIds: orderedRoutes.map((route) => route.providerId),
      strategy: typeof decision.strategy === "object" && decision.strategy !== null ? decision.strategy.mode : decision.strategy,
    }, "CLJS policy authoritative provider order applied");
    return { providerRoutes: orderedRoutes, decision, catalog: cljsFiltered.catalog };
  } catch (error) {
    eligibleInput.log.warn({ model: eligibleInput.routedModel, error }, "CLJS policy preview threw");
    return { providerRoutes: eligibleInput.config.cljsPolicyAuthoritative === true ? [] : [...eligibleInput.providerRoutes], catalog: cljsFiltered.catalog };
  }
}

export function applyCljsProviderPolicy(input: CljsProviderPolicyInput): ProviderRoute[] {
  return applyCljsProviderPolicyWithDecision(input).providerRoutes;
}

/**
 * Build provider routes exclusively from CLJS policy contracts, replacing
 * the env-var-driven buildProviderRoutesWithDynamicBaseUrls.
 *
 * Returns routes from :provider-route and :provider-seed contracts in the
 * manifest. When the CLJS runtime is unavailable, falls back to the config's
 * upstreamProviderBaseUrls so tests and development environments still work.
 */
export function getContractProviderRoutes(config: Pick<ProxyConfig, "cljsPolicyManifestPath" | "upstreamProviderBaseUrls" | "openaiProviderId" | "openaiBaseUrl">): ProviderRoute[] {
  const runtime = getActiveCljsRuntime();

  if (runtime?.getProviderRoutes) {
    try {
      const manifestPath = config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn";
      const result = runtime.getProviderRoutes(manifestPath);
      if (result.status === "ok") {
        return providerRoutesFromRaw(result.providerRoutes ?? result["provider-routes"]) ?? [];
      }
    } catch {
      /* fall through to env-var fallback */
    }
  }

  const seen = new Set<string>();
  const routes: ProviderRoute[] = [];
  for (const [providerId, baseUrl] of Object.entries(config.upstreamProviderBaseUrls ?? {})) {
    const id = providerId.trim();
    const url = (typeof baseUrl === "string" ? baseUrl : "").trim().replace(/\/+$/, "");
    if (id && url && !seen.has(id)) {
      seen.add(id);
      routes.push({ providerId: id, baseUrl: url });
    }
  }
  return routes;
}

/** Backwards-compatible shadow-only wrapper for tests and callers that only want observability. */
export function shadowPreviewProviderPolicy(input: CljsProviderPolicyInput): void {
  applyCljsProviderPolicy({
    ...input,
    config: { ...input.config, cljsPolicyAuthoritative: false },
  });
}
