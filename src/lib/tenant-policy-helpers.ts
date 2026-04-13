import { resolveRequestRoutingState } from "./provider-routing.js";

interface TenantSettings {
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
