import type { ProviderRoute } from "./provider-routing.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";

export function prependDynamicOllamaRoutes(
  routes: readonly ProviderRoute[],
  discovered: readonly ProviderRoute[],
): ProviderRoute[] {
  const seen = new Set<string>();
  const merged: ProviderRoute[] = [];

  for (const route of discovered) {
    const id = route.providerId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(route);
  }

  for (const route of routes) {
    const id = route.providerId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(route);
  }

  return merged;
}

export function filterDedicatedOllamaRoutes(routes: readonly ProviderRoute[]): ProviderRoute[] {
  return routes.filter((route) => {
    const providerId = route.providerId.trim().toLowerCase();
    return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
  });
}

export function hasDedicatedOllamaRoutes(routes: readonly ProviderRoute[]): boolean {
  return filterDedicatedOllamaRoutes(routes).length > 0;
}

export async function discoverDynamicOllamaRoutes(
  sqlCredentialStore: SqlCredentialStore | undefined,
): Promise<ProviderRoute[]> {
  if (!sqlCredentialStore) {
    return [];
  }

  try {
    const providers = await sqlCredentialStore.listProvidersWithBaseUrlByPrefix("ollama-");
    return providers.map((p) => ({ providerId: p.id, baseUrl: p.baseUrl }));
  } catch {
    return [];
  }
}
