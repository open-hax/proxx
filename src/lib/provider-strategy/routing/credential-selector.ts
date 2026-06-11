import type { ProviderCredential } from "../../key-pool.js";
import type { RequestLogStore } from "../../request-log-store.js";

export interface PreferredAffinity {
  readonly providerId: string;
  readonly accountId: string;
}

export function reorderCandidatesForAffinities<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: readonly { readonly providerId: string; readonly accountId: string }[],
): T[] {
  if (preferred.length === 0) {
    return [...candidates];
  }

  const used = new Set<string>();
  const ordered: T[] = [];

  for (const preference of preferred) {
    for (const candidate of candidates) {
      if (candidate.providerId !== preference.providerId || candidate.account.accountId !== preference.accountId) {
        continue;
      }

      const key = `${candidate.providerId}\0${candidate.account.accountId}`;
      if (used.has(key)) {
        continue;
      }

      used.add(key);
      ordered.push(candidate);
    }
  }

  if (ordered.length === 0) {
    return [...candidates];
  }

  const remaining = candidates.filter((candidate) => !used.has(`${candidate.providerId}\0${candidate.account.accountId}`));
  return [...ordered, ...remaining];
}

export function reorderCandidatesForAffinity<T extends { readonly providerId: string; readonly account: ProviderCredential }>(
  candidates: readonly T[],
  preferred: PreferredAffinity | undefined,
): T[] {
  return reorderCandidatesForAffinities(candidates, preferred ? [preferred] : []);
}

function planCostTier(planType: string | undefined): number {
  const normalized = (planType ?? "").trim().toLowerCase();
  switch (normalized) {
    case "free":
      return 0;
    case "team":
      return 1;
    case "plus":
    case "pro":
    case "business":
    case "enterprise":
      return 2;
    case "unknown":
    default:
      return 1;
  }
}

export function providerAccountsForRequest(
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
): ProviderCredential[] {
  if (providerId !== "openai") {
    return [...accounts];
  }

  const isGptModel = routedModel.startsWith("gpt-");
  if (!isGptModel) {
    return [...accounts];
  }

  const freeAccounts = accounts.filter((account) => account.planType === "free");
  const nonFreeAccounts = accounts.filter((account) => account.planType !== "free");
  const prioritized = freeAccounts.length > 0
    ? [...freeAccounts, ...nonFreeAccounts]
    : [...accounts];

  return prioritized;
}

export function reorderAccountsForLatency(
  requestLogStore: RequestLogStore,
  providerId: string,
  accounts: readonly ProviderCredential[],
  routedModel: string,
  upstreamMode: string,
): ProviderCredential[] {
  const TTFT_GRACE_MS = 120;
  const WINDOW_SIZE = 6;

  const window = [...accounts.slice(0, WINDOW_SIZE)];
  const tail = accounts.slice(window.length);

  const perfFor = (account: ProviderCredential) => {
    return requestLogStore.getPerfSummary(providerId, account.accountId, routedModel, upstreamMode);
  };

  window.sort((a, b) => {
    const perfA = perfFor(a);
    const perfB = perfFor(b);

    const ttftA = perfA?.ewmaTtftMs ?? Number.POSITIVE_INFINITY;
    const ttftB = perfB?.ewmaTtftMs ?? Number.POSITIVE_INFINITY;
    const ttftDelta = Math.abs(ttftA - ttftB);
    if (ttftDelta > TTFT_GRACE_MS) {
      return ttftA - ttftB;
    }

    const costA = planCostTier(a.planType);
    const costB = planCostTier(b.planType);
    if (costA !== costB) {
      return costA - costB;
    }

    const tpsA = perfA?.ewmaTps ?? Number.NEGATIVE_INFINITY;
    const tpsB = perfB?.ewmaTps ?? Number.NEGATIVE_INFINITY;
    if (tpsA !== tpsB) {
      return tpsB - tpsA;
    }

    return 0;
  });

  return [...window, ...tail];
}
