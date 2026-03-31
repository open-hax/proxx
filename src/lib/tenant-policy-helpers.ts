import { resolveRequestRoutingState } from "./provider-routing.js";

interface TenantSettings {
  readonly allowedModels: readonly string[] | null;
  readonly allowedProviderIds: readonly string[] | null;
  readonly disabledProviderIds: readonly string[] | null;
}

function normalizeModelVariants(model: string): readonly string[] {
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) {
    return [];
  }

  const variants = new Set<string>([trimmed]);
  if (trimmed.startsWith("ollama/")) {
    variants.add(trimmed.slice("ollama/".length));
  }
  if (trimmed.startsWith("ollama:")) {
    variants.add(trimmed.slice("ollama:".length));
  }
  return [...variants];
}

export function tenantModelAllowed(settings: TenantSettings, ...models: Array<string | undefined>): boolean {
  if (!settings.allowedModels || settings.allowedModels.length === 0) {
    return true;
  }

  const allowed = new Set<string>();
  for (const allowedModel of settings.allowedModels) {
    for (const variant of normalizeModelVariants(allowedModel)) {
      allowed.add(variant);
    }
  }

  const candidates = new Set<string>();
  for (const model of models) {
    if (typeof model !== "string") {
      continue;
    }

    for (const variant of normalizeModelVariants(model)) {
      candidates.add(variant);
    }
  }

  if (candidates.size === 0) {
    return false;
  }

  return [...candidates].some((candidate) => allowed.has(candidate));
}

export function tenantProviderAllowed(settings: TenantSettings, providerId: string): boolean {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (settings.allowedProviderIds && !settings.allowedProviderIds.includes(normalizedProviderId)) {
    return false;
  }

  if (settings.disabledProviderIds?.includes(normalizedProviderId)) {
    return false;
  }

  return true;
}

export function filterTenantProviderRoutes(
  routes: readonly { readonly providerId: string; readonly baseUrl: string }[],
  settings: TenantSettings,
): { readonly providerId: string; readonly baseUrl: string }[] {
  return routes.filter((route) => tenantProviderAllowed(settings, route.providerId));
}

export function resolveExplicitTenantProviderId(
  config: { readonly openaiProviderId: string },
  model: string,
  settings: TenantSettings,
): string | undefined {
  const routingState = resolveRequestRoutingState(config as never, model);
  const providerId = routingState.factoryPrefixed
    ? "factory"
    : routingState.openAiPrefixed
      ? config.openaiProviderId
      : routingState.explicitOllama || routingState.localOllama
        ? "ollama"
        : undefined;

  return providerId && !tenantProviderAllowed(settings, providerId) ? providerId : undefined;
}
