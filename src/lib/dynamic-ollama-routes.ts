import type { ProviderRoute } from "./provider-routing.js";
import type { SqlCredentialStore } from "./db/sql-credential-store.js";
import type { SqlFederationStore } from "./db/sql-federation-store.js";

export async function discoverDynamicOllamaRoutes(
  sqlCredentialStore: SqlCredentialStore | undefined,
  sqlFederationStore?: SqlFederationStore,
  ownerSubject?: string,
): Promise<ProviderRoute[]> {
  const routes: ProviderRoute[] = [];
  const seen = new Set<string>();

  try {
    if (sqlCredentialStore) {
      const providers = await sqlCredentialStore.listProvidersWithBaseUrlByPrefix("ollama-");
      for (const provider of providers) {
        if (seen.has(provider.id)) {
          continue;
        }
        seen.add(provider.id);
        routes.push({ providerId: provider.id, baseUrl: provider.baseUrl });
      }
    }
  } catch {
    // ignore credential-store lookup failures; federation routes can still fill the gap
  }

  try {
    if (sqlFederationStore && ownerSubject) {
      const projectedAccounts = await sqlFederationStore.getProjectedAccountsForOwner(ownerSubject);
      const peers = await sqlFederationStore.listPeers();
      const peersById = new Map(peers.map((peer) => [peer.id, peer] as const));

      for (const account of projectedAccounts) {
        if (!account.providerId.startsWith("ollama-") || seen.has(account.providerId)) {
          continue;
        }

        const peer = peersById.get(account.sourcePeerId);
        if (!peer?.baseUrl) {
          continue;
        }

        seen.add(account.providerId);
        routes.push({ providerId: account.providerId, baseUrl: peer.baseUrl });
      }
    }
  } catch {
    // ignore federation-store lookup failures; local dynamic routes may still exist
  }

  return routes;
}

export function prependDynamicOllamaRoutes(
  routes: readonly ProviderRoute[],
  dynamicRoutes: readonly ProviderRoute[],
): ProviderRoute[] {
  const merged: ProviderRoute[] = [];
  const seenProviderIds = new Set<string>();

  for (const route of [...dynamicRoutes, ...routes]) {
    const providerId = route.providerId.trim();
    if (providerId.length === 0 || seenProviderIds.has(providerId)) {
      continue;
    }
    seenProviderIds.add(providerId);
    merged.push(route);
  }

  return merged;
}

export function filterDedicatedOllamaRoutes(
  routes: readonly ProviderRoute[],
): ProviderRoute[] {
  return routes.filter((route) => {
    const providerId = route.providerId.trim().toLowerCase();
    return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
  });
}

export function hasDedicatedOllamaRoutes(
  routes: readonly ProviderRoute[],
): boolean {
  return routes.some((route) => {
    const providerId = route.providerId.trim().toLowerCase();
    return providerId.startsWith("ollama-") && providerId !== "ollama-cloud";
  });
}
