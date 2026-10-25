import type { FastifyReply } from "fastify";

import type { ProviderCatalogStore, ResolvedCatalogWithPreferences } from "./provider-catalog.js";
import type { ResolvedModelCatalog } from "./provider-routing.js";
import { sendOpenAiError } from "./provider-utils.js";
import { kernels } from "./cljs-kernels.js";
import { policyManifestPath } from "./policy-manifest.js";

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

    const decision = kernels.resolveCatalogAlias(
      policyManifestPath(),
      catalogBundle,
      requestedModelInput,
      options?.preserveExplicitOllama,
    );
    if (decision.error) {
      const { status, message, type, code } = decision.error;
      sendOpenAiError(reply, status, message, type, code);
      return null;
    }

    routingModelInput = decision.routingModelInput ?? requestedModelInput;
    aliasApplied = decision.aliasApplied === true;
    if (aliasApplied) {
      reply.header("x-open-hax-model-alias", `${requestedModelInput}->${routingModelInput}`);
    }
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "failed to resolve dynamic model aliases; using requested model as-is");
  }

  return { routingModelInput, resolvedModelCatalog, resolvedCatalogBundle, aliasApplied };
}
