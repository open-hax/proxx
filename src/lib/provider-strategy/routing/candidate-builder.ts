import type { ProviderCredential } from "../../key-pool.js";
import { kernels } from "../../cljs-kernels.js";
import {
  providerAccountsForRequest,
  reorderAccountsForLatency,
  reorderCandidatesForAffinities,
} from "./credential-selector.js";
import type { RoutingCandidate, RoutingDeps } from "./types.js";

export interface BuildCandidatesResult {
  readonly candidates: readonly RoutingCandidate[];
  readonly preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
  readonly provisionalAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
}

export async function buildRoutingCandidates(
  deps: RoutingDeps,
): Promise<BuildCandidatesResult> {
  const { keyPool, providerRoutes, context, promptAffinityStore, promptCacheKey, quotaMonitor, strategy, requestLogStore } = deps;

  const candidatesByProvider: Record<string, RoutingCandidate[]> = {};
  const forcedCredentialSelection = kernels.forcedCredentialSelection(context.requestAuth?.kind, context.clientHeaders);

  for (const route of providerRoutes) {
    if (forcedCredentialSelection.providerId && route.providerId !== forcedCredentialSelection.providerId) {
      continue;
    }

    let routeAccounts: ProviderCredential[];
    try {
      const rawAccounts = await keyPool.getRequestOrder(route.providerId);
      routeAccounts = providerAccountsForRequest(rawAccounts, route.providerId, context.routedModel);
    } catch {
      if (route.authRequired !== false) {
        continue;
      }
      routeAccounts = [];
    }

    if (route.authRequired === false) {
      routeAccounts = [kernels.noAuthAccount(route.providerId)];
    }

    if (quotaMonitor?.tracksProvider(route.providerId)) {
      routeAccounts = routeAccounts.filter((account) => !quotaMonitor.isAccountExhausted(account.accountId));
    }

    routeAccounts = reorderAccountsForLatency(requestLogStore, route.providerId, routeAccounts, context.routedModel, strategy.mode);

    if (forcedCredentialSelection.accountId) {
      routeAccounts = routeAccounts.filter((account) => account.accountId === forcedCredentialSelection.accountId);
    }

    const routeCandidates = routeAccounts.map((account) => ({
      providerId: route.providerId,
      baseUrl: route.baseUrl,
      account,
      ...(route.paths ? { paths: route.paths } : {}),
    }));

    if (routeCandidates.length > 0) {
      candidatesByProvider[route.providerId] = routeCandidates;
    }
  }

  const affinityRecord = promptCacheKey
    ? await promptAffinityStore.get(promptCacheKey)
    : undefined;
  const { preferred: preferredAffinity, provisional: provisionalAffinity } = kernels.affinitiesFromRecord(affinityRecord);

  const allCandidates = providerRoutes.flatMap((route) => candidatesByProvider[route.providerId] ?? []);

  const providerIndex = new Map(providerRoutes.map((route, index) => [route.providerId, index] as const));

  const sortedCandidates = kernels
    .candidateOrderForRoutes(
      allCandidates.map((candidate) => {
        const perf = requestLogStore.getPerfSummary(candidate.providerId, candidate.account.accountId, context.routedModel, strategy.mode);
        const ttft = perf?.ewmaTtftMs;
        return {
          providerIndex: providerIndex.get(candidate.providerId),
          ttft: typeof ttft === "number" && Number.isFinite(ttft) ? ttft : undefined,
        };
      }),
      context.config.cljsPolicyManifestPath,
    )
    .map((index) => allCandidates[index]!);

  const candidates = reorderCandidatesForAffinities(
    sortedCandidates,
    [preferredAffinity, provisionalAffinity].filter((value): value is { readonly providerId: string; readonly accountId: string } => Boolean(value)),
  );

  return { candidates, preferredAffinity, provisionalAffinity };
}
