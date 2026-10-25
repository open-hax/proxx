import type { ProviderCredential } from "../../key-pool.js";
import { kernels } from "../../cljs-kernels.js";
import type { StrategyRequestContext } from "../shared.js";
import {
  providerAccountsForRequest,
  reorderAccountsForLatency,
  reorderCandidatesForAffinities,
} from "./credential-selector.js";
import type { RoutingCandidate, RoutingDeps } from "./types.js";

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
  readonly candidates: readonly RoutingCandidate[];
  readonly preferredAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
  readonly provisionalAffinity: { readonly providerId: string; readonly accountId: string } | undefined;
}

export async function buildRoutingCandidates(
  deps: RoutingDeps,
): Promise<BuildCandidatesResult> {
  const { keyPool, providerRoutes, context, promptAffinityStore, promptCacheKey, quotaMonitor, strategy, requestLogStore } = deps;

  const candidatesByProvider: Record<string, RoutingCandidate[]> = {};
  const forcedCredentialSelection = resolveForcedCredentialSelection(context);

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
      routeAccounts = [{
        providerId: route.providerId,
        accountId: `${route.providerId}-no-auth`,
        token: "",
        authType: "api_key",
        planType: "free",
      }];
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
  const preferredAffinity = affinityRecord
    ? { providerId: affinityRecord.providerId, accountId: affinityRecord.accountId }
    : undefined;
  const provisionalAffinity = affinityRecord?.provisionalProviderId && affinityRecord?.provisionalAccountId
    ? { providerId: affinityRecord.provisionalProviderId, accountId: affinityRecord.provisionalAccountId }
    : undefined;

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
