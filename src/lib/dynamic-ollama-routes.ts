import type { ProviderRoute } from "./provider-routing.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";

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
