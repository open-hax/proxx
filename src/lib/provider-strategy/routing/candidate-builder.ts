import type { ProviderCredential } from "../../key-pool.js";
import type { StrategyRequestContext } from "../shared.js";
import {
  providerAccountsForRequest,
  providerAccountsForRequestWithPolicy,
  reorderAccountsForLatency,
  reorderCandidatesForAffinities,
} from "./credential-selector.js";
import type { FallbackCandidate, FallbackDeps } from "./types.js";

function resolveForcedCredentialSelection(context: StrategyRequestContext): {
  readonly providerId?: string;
  readonly accountId?: string;
} {
  if (context.requestAuth?.kind !== "legacy_admin") {
    return {};
  }

  const providerId = readHeaderValue(context.clientHeaders, "x-open-hax-forced-provider")?.trim().toLowerCase();
  const accountId = readHeaderValue(context.clientHeaders, "x-open-hax-forced-account-id")?.trim();
  return {
    providerId: providerId && providerId.length > 0 ? providerId : undefined,
    accountId: accountId && accountId.length > 0 ? accountId : undefined,
  };
}

function readHeaderValue(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return typeof value === "string" ? value : undefined;
}

export interface BuildCandidatesResult {
  readonly candidates: readonly FallbackCandidate[];
  readonly preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
  readonly provisionalAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
}

export async function buildFallbackCandidates(
  deps: FallbackDeps,
): Promise<BuildCandidatesResult> {
  const { keyPool, providerRoutes, context, promptAffinityStore, promptCacheKey, policy, healthStore, quotaMonitor, strategy, requestLogStore } = deps;

  const candidatesByProvider: Record<string, FallbackCandidate[]> = {};
  const forcedCredentialSelection = resolveForcedCredentialSelection(context);

  for (const route of providerRoutes) {
    if (forcedCredentialSelection.providerId && route.providerId !== forcedCredentialSelection.providerId) {
      continue;
    }

    let routeAccounts: ProviderCredential[];
    try {
      const rawAccounts = await keyPool.getRequestOrder(route.providerId);
      routeAccounts = policy
        ? providerAccountsForRequestWithPolicy(policy, rawAccounts, route.providerId, context.routedModel, {
            openAiPrefixed: context.openAiPrefixed,
            localOllama: context.localOllama,
            explicitOllama: context.explicitOllama,
          }, healthStore)
        : providerAccountsForRequest(rawAccounts, route.providerId, context.routedModel);
    } catch {
      continue;
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
    }));

    if (routeCandidates.length > 0) {
      candidatesByProvider[route.providerId] = routeCandidates;
    }
  }

  const affinityRecord = promptCacheKey
    ? await promptAffinityStore.get(promptCacheKey)
    : undefined;
  const preferredAffinity = affinityRecord
    ? { providerId: affinityRecord.providerId, accountId: affinityRecord.accountId }
    : undefined;
  const provisionalAffinity = affinityRecord?.provisionalProviderId && affinityRecord?.provisionalAccountId
    ? { providerId: affinityRecord.provisionalProviderId, accountId: affinityRecord.provisionalAccountId }
    : undefined;

  const allCandidates = providerRoutes.flatMap((route) => candidatesByProvider[route.providerId] ?? []);

  const providerIndex = new Map(providerRoutes.map((route, index) => [route.providerId, index] as const));

  const sortedCandidates = [...allCandidates].sort((left, right) => {
    const idxLeft = providerIndex.get(left.providerId) ?? Number.MAX_SAFE_INTEGER;
    const idxRight = providerIndex.get(right.providerId) ?? Number.MAX_SAFE_INTEGER;

    if (idxLeft !== idxRight) {
      const perfLeft = requestLogStore.getPerfSummary(left.providerId, left.account.accountId, context.routedModel, strategy.mode);
      const perfRight = requestLogStore.getPerfSummary(right.providerId, right.account.accountId, context.routedModel, strategy.mode);

      const ttftLeft = perfLeft?.ewmaTtftMs;
      const ttftRight = perfRight?.ewmaTtftMs;
      if (
        typeof ttftLeft === "number" && Number.isFinite(ttftLeft)
        && typeof ttftRight === "number" && Number.isFinite(ttftRight)
      ) {
        const ttftDelta = Math.abs(ttftLeft - ttftRight);
        if (ttftDelta > 120) {
          return ttftLeft - ttftRight;
        }
      }

      return idxLeft - idxRight;
    }

    return 0;
  });

  const candidates = reorderCandidatesForAffinities(
    sortedCandidates,
    [preferredAffinity, provisionalAffinity].filter((value): value is { readonly providerId: string; readonly accountId: string } => Boolean(value)),
  );

  return { candidates, preferredAffinity, provisionalAffinity };
}
