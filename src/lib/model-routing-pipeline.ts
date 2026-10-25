import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "./config.js";
import type { ProviderCatalogStore, ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ResolvedModelCatalog } from "./provider-routing.js";
import type { ProxySettings } from "./proxy-settings-store.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import { getActiveCljsRuntime } from "./cljs-runtime.js";
import { kernels } from "./cljs-kernels.js";
import { sendOpenAiError } from "./provider-utils.js";
import { resolveCatalogAndAlias } from "./catalog-alias-resolver.js";
import {
  resolvableConcreteModelIds,
} from "./catalog-resolution.js";
import { isAutoModel, rankAutoModels } from "./auto-model-selector.js";
import { isCephalonAutoModel, buildCephalonModelCandidates } from "./provider-strategy/strategies/cephalon.js";
import { isVisionAutoModel, buildVisionModelCandidates } from "./provider-strategy/strategies/vision.js";

export interface ModelRoutingDeps {
  readonly config: ProxyConfig;
  readonly proxySettings: ProxySettings;
  readonly providerCatalogStore: ProviderCatalogStore;
  readonly requestLogStore: RequestLogStore;
  readonly accountHealthStore?: AccountHealthStore;
}

export interface ModelRoutingResult {
  readonly requestedModelInput: string;
  readonly routingModelInput: string;
  readonly resolvedModelCatalog: ResolvedModelCatalog | null;
  readonly resolvedCatalogBundle: ResolvedCatalogWithPreferences | null;
  readonly routingModelCandidates: readonly string[];
  readonly isAutoModel: boolean;
}

function policyDeniesModel(config: ProxyConfig, tenantSettings: ProxySettings, modelId: string): boolean {
  const result = getActiveCljsRuntime()?.previewPolicyDecision(config.cljsPolicyManifestPath ?? "resources/policies/runtime/00-manifest.edn", {
    modelId,
    requestKind: "chat",
    tenantSettings,
    providerIds: [],
  });
  return kernels.tenantDeniesModel(result);
}

export async function resolveModelRouting(
  deps: ModelRoutingDeps,
  requestBody: Record<string, unknown>,
  reply: FastifyReply,
  log: { warn(obj: Record<string, unknown>, msg: string): void },
  options?: {
    preserveExplicitOllama?: boolean;
  },
): Promise<ModelRoutingResult | null> {
  const checked = kernels.checkRequestedModel(requestBody);
  if (checked.error || checked.model === undefined) {
    const { status, message, type, code } = checked.error ?? kernels.tenantDeniedError("");
    sendOpenAiError(reply, status, message, type, code);
    return null;
  }
  const requestedModelInput = checked.model;

  if (policyDeniesModel(deps.config, deps.proxySettings, requestedModelInput)) {
    const { status, message, type, code } = kernels.tenantDeniedError(requestedModelInput);
    sendOpenAiError(reply, status, message, type, code);
    return null;
  }

  const catalogResult = await resolveCatalogAndAlias(
    deps.providerCatalogStore,
    requestedModelInput,
    reply,
    log,
    { preserveExplicitOllama: options?.preserveExplicitOllama },
  );
  if (!catalogResult) {
    return null;
  }

  const { routingModelInput, resolvedModelCatalog, resolvedCatalogBundle } = catalogResult;
  const source = kernels.routingCandidateSource({
    cephalon: isCephalonAutoModel(routingModelInput),
    vision: isVisionAutoModel(routingModelInput),
    auto: isAutoModel(routingModelInput),
  });

  const concreteModelIds = resolvableConcreteModelIds(resolvedModelCatalog);
  const requestLogStore = deps.requestLogStore;
  const accountHealthStore = deps.accountHealthStore;
  const upstreamProviderId = deps.config.upstreamProviderId;

  let produced: string[];
  if (source === "cephalon") {
    produced = buildCephalonModelCandidates({
      routingModelInput,
      requestBody,
      catalog: resolvedModelCatalog,
      availableModels: concreteModelIds,
      providerId: upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    });
  } else if (source === "vision") {
    produced = buildVisionModelCandidates({
      routingModelInput,
      requestBody,
      catalog: resolvedModelCatalog,
      availableModels: concreteModelIds,
      providerId: upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    });
  } else if (source === "auto") {
    produced = rankAutoModels(
      routingModelInput,
      requestBody,
      concreteModelIds,
      upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    ).map((entry) => entry.modelId);
  } else {
    produced = [routingModelInput];
  }

  const finished = kernels.finishModelRouting(requestedModelInput, source, produced);
  if (finished.error || finished.candidates === undefined) {
    const { status, message, type, code } = finished.error ?? kernels.tenantDeniedError(requestedModelInput);
    sendOpenAiError(reply, status, message, type, code);
    return null;
  }

  if (finished.candidatesHeader !== undefined) {
    reply.header("x-open-hax-auto-model-candidates", finished.candidatesHeader);
  }

  return {
    requestedModelInput,
    routingModelInput,
    resolvedModelCatalog,
    resolvedCatalogBundle,
    routingModelCandidates: finished.candidates,
    isAutoModel: finished.isAutoModel === true,
  };
}
