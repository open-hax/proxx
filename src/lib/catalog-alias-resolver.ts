import type { FastifyReply } from "fastify";

import type { ProviderCatalogStore, ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ResolvedModelCatalog } from "./provider-routing.js";
import { sendOpenAiError } from "./provider-utils.js";

export interface CatalogAliasResult {
  readonly routingModelInput: string;
  readonly resolvedModelCatalog: ResolvedModelCatalog | null;
  readonly resolvedCatalogBundle: ResolvedCatalogWithPreferences | null;
  readonly aliasApplied: boolean;
}

export async function resolveCatalogAndAlias(
  catalogStore: ProviderCatalogStore,
  requestedModelInput: string,
  reply: FastifyReply,
  log: { warn(obj: Record<string, unknown>, msg: string): void },
  options?: { preserveExplicitOllama?: boolean },
): Promise<CatalogAliasResult | null> {
  let routingModelInput = requestedModelInput;
  let resolvedModelCatalog: ResolvedModelCatalog | null = null;
  let resolvedCatalogBundle: ResolvedCatalogWithPreferences | null = null;
  let aliasApplied = false;

  try {
    const catalogBundle = await catalogStore.getCatalog();
    resolvedCatalogBundle = catalogBundle;
    resolvedModelCatalog = catalogBundle.catalog;

    const disabledModelSet = new Set(catalogBundle.preferences.disabled);
    if (disabledModelSet.has(requestedModelInput) || disabledModelSet.has(catalogBundle.catalog.aliasTargets[requestedModelInput] ?? "")) {
      sendOpenAiError(reply, 403, `Model is disabled: ${requestedModelInput}`, "invalid_request_error", "model_disabled");
      return null;
    }

    const aliasTarget = catalogBundle.catalog.aliasTargets[requestedModelInput];
    if (typeof aliasTarget === "string" && aliasTarget.length > 0) {
      if (options?.preserveExplicitOllama) {
        const requestedLower = requestedModelInput.trim().toLowerCase();
        const aliasLower = aliasTarget.trim().toLowerCase();
        const requestedWasExplicitOllama = requestedLower.startsWith("ollama/") || requestedLower.startsWith("ollama:")
          || requestedLower.startsWith("ollama-lan/") || requestedLower.startsWith("ollama-lan:");
        const aliasIsExplicitOllama = aliasLower.startsWith("ollama/") || aliasLower.startsWith("ollama:")
          || aliasLower.startsWith("ollama-lan/") || aliasLower.startsWith("ollama-lan:");
        routingModelInput = requestedWasExplicitOllama && !aliasIsExplicitOllama
          ? requestedModelInput
          : aliasTarget;
      } else {
        routingModelInput = aliasTarget;
      }
      aliasApplied = routingModelInput !== requestedModelInput;
      if (aliasApplied) {
        reply.header("x-open-hax-model-alias", `${requestedModelInput}->${routingModelInput}`);
      }
    }
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "failed to resolve dynamic model aliases; using requested model as-is");
  }

  return { routingModelInput, resolvedModelCatalog, resolvedCatalogBundle, aliasApplied };
}
