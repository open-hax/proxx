import { resolveRequestRoutingState } from "../../provider-routing.js";

export interface TenantSettings {
  readonly allowedModels: readonly string[] | null;
  readonly allowedProviderIds: readonly string[] | null;
  readonly disabledProviderIds: readonly string[] | null;
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

export function tenantModelAllowed(settings: TenantSettings, model: string): boolean {
  if (!settings.allowedModels || settings.allowedModels.length === 0) {
    return true;
  }

  const normalized = model.trim().toLowerCase();
  for (const allowed of settings.allowedModels) {
    const allowedNormalized = allowed.trim().toLowerCase();
    if (normalized === allowedNormalized) {
      return true;
    }
    // Support ollama prefix normalization: "ollama/model:tag" matches "model:tag"
    const withoutOllamaPrefix = normalized.startsWith("ollama/")
      ? normalized.slice(7)
      : normalized.startsWith("ollama:")
        ? normalized.slice(7)
        : normalized;
    const allowedWithoutPrefix = allowedNormalized.startsWith("ollama/")
      ? allowedNormalized.slice(7)
      : allowedNormalized.startsWith("ollama:")
        ? allowedNormalized.slice(7)
        : allowedNormalized;
    if (withoutOllamaPrefix === allowedWithoutPrefix) {
      return true;
    }
  }

  return false;
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
