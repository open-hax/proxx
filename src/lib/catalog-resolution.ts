import { kernels } from "./cljs-kernels.js";
import type { ResolvedCatalogWithPreferences } from "./provider-catalog.js";

interface ResolvedModelCatalog {
  readonly modelIds: readonly string[];
  readonly aliasTargets: Readonly<Record<string, string>>;
  readonly dynamicOllamaModelIds: readonly string[];
}

export const resolvableConcreteModelIds = (catalog: ResolvedModelCatalog | null): string[] | undefined =>
  kernels.resolvableConcreteModelIds(catalog);

export const resolvableConcreteModelIdsForProviders = (
  catalogBundle: ResolvedCatalogWithPreferences | null,
  providerIds: readonly string[],
  includeDeclaredModel?: (modelId: string) => boolean,
): string[] | undefined => kernels.resolvableConcreteModelIdsForProviders(catalogBundle, providerIds, includeDeclaredModel);
