import type { FastifyReply } from "fastify";

import type { ProxyConfig } from "./config.js";
import type { ProviderCatalogStore, ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ResolvedModelCatalog } from "./provider-routing.js";
import type { ProxySettings } from "./proxy-settings-store.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";
import {
  tenantModelAllowed,
  resolveExplicitTenantProviderId,
} from "./tenant-policy-helpers.js";
import { sendOpenAiError } from "./provider-utils.js";
import { resolveCatalogAndAlias } from "./catalog-alias-resolver.js";
import {
  resolvableConcreteModelIds,
} from "./model-routing-helpers.js";
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

export async function resolveModelRouting(
  deps: ModelRoutingDeps,
  requestBody: Record<string, unknown>,
  reply: FastifyReply,
  log: { warn(obj: Record<string, unknown>, msg: string): void },
  options?: {
    preserveExplicitOllama?: boolean;
  },
): Promise<ModelRoutingResult | null> {
  const requestedModelInput = typeof requestBody.model === "string" ? requestBody.model : "";
  if (requestedModelInput.length === 0) {
    sendOpenAiError(reply, 400, "Missing required field: model", "invalid_request_error", "missing_model");
    return null;
  }

  if (!tenantModelAllowed(deps.proxySettings, requestedModelInput)) {
    sendOpenAiError(reply, 403, `Model is disabled for this tenant: ${requestedModelInput}`, "invalid_request_error", "model_not_allowed");
    return null;
  }

  const explicitlyBlockedProviderId = resolveExplicitTenantProviderId(deps.config, requestedModelInput, deps.proxySettings);
  if (explicitlyBlockedProviderId) {
    sendOpenAiError(reply, 403, `Provider is disabled for this tenant: ${explicitlyBlockedProviderId}`, "invalid_request_error", "provider_not_allowed");
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
  const autoModel = isAutoModel(routingModelInput);
  const cephalonAutoModel = isCephalonAutoModel(routingModelInput);
  const visionAutoModel = isVisionAutoModel(routingModelInput);

  const concreteModelIds = resolvableConcreteModelIds(resolvedModelCatalog);
  const requestLogStore = deps.requestLogStore;
  const accountHealthStore = deps.accountHealthStore;
  const upstreamProviderId = deps.config.upstreamProviderId;

  let routingModelCandidates: string[];
  if (cephalonAutoModel) {
    routingModelCandidates = buildCephalonModelCandidates({
      routingModelInput,
      requestBody,
      catalog: resolvedModelCatalog,
      availableModels: concreteModelIds,
      providerId: upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    });
  } else if (visionAutoModel) {
    routingModelCandidates = buildVisionModelCandidates({
      routingModelInput,
      requestBody,
      catalog: resolvedModelCatalog,
      availableModels: concreteModelIds,
      providerId: upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    });
  } else if (autoModel) {
    routingModelCandidates = rankAutoModels(
      routingModelInput,
      requestBody,
      concreteModelIds,
      upstreamProviderId,
      requestLogStore,
      accountHealthStore,
    ).map((entry) => entry.modelId);
  } else {
    routingModelCandidates = [routingModelInput];
  }

  if (routingModelCandidates.length === 0) {
    sendOpenAiError(reply, 404, `Model not found: ${requestedModelInput}`, "invalid_request_error", "model_not_found");
    return null;
  }

  if (autoModel || cephalonAutoModel || visionAutoModel) {
    reply.header("x-open-hax-auto-model-candidates", routingModelCandidates.slice(0, 12).join(","));
  }

  return {
    requestedModelInput,
    routingModelInput,
    resolvedModelCatalog,
    resolvedCatalogBundle,
    routingModelCandidates,
    isAutoModel: autoModel || cephalonAutoModel || visionAutoModel,
  };
}
