import type { ProviderCredential } from "../../key-pool.js";
import type { PolicyEngine } from "../../policy/index.js";
import type { AccountHealthStore } from "../../db/account-health-store.js";
import type { RequestLogStore } from "../../request-log-store.js";
import { orderAccountsByPolicy } from "../../provider-policy.js";

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

export function gptModelRequiresPaidPlan(routedModel: string): boolean {
  const match = routedModel.match(/^gpt-(\d+)(?:[.-]([a-z0-9]+))?/i);
  if (!match) {
    return false;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(major)) {
    return false;
  }

  if (major > 5) {
    return true;
  }

  if (major !== 5) {
    return false;
  }

  const qualifier = match[2];
  if (!qualifier) {
    return false;
  }

  if (/^\d+$/.test(qualifier)) {
    const minor = Number.parseInt(qualifier, 10);
    return Number.isFinite(minor) && minor >= 3;
  }

  return true;
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

  if (gptModelRequiresPaidPlan(routedModel)) {
    const stronglySupportedPlans = new Set(["plus", "pro", "business", "enterprise"]);

    const stronglySupportedAccounts = accounts.filter(
      (account) => stronglySupportedPlans.has(account.planType ?? ""),
    );

    const teamAccounts = accounts.filter((account) => account.planType === "team");

    const otherPaidAccounts = accounts.filter((account) => {
      const planType = account.planType ?? "unknown";
      if (planType === "free") {
        return false;
      }
      if (planType === "team") {
        return false;
      }
      if (stronglySupportedPlans.has(planType)) {
        return false;
      }
      return true;
    });

    const freeAccounts = accounts.filter((account) => account.planType === "free");

    return [
      ...stronglySupportedAccounts,
      ...teamAccounts,
      ...otherPaidAccounts,
      ...freeAccounts,
    ];
  }

  const freeAccounts = accounts.filter((account) => account.planType === "free");
  const nonFreeAccounts = accounts.filter((account) => account.planType !== "free");
  const prioritized = freeAccounts.length > 0
    ? [...freeAccounts, ...nonFreeAccounts]
    : [...accounts];

  return prioritized;
}

export function providerAccountsForRequestWithPolicy(
  policy: PolicyEngine,
  accounts: readonly ProviderCredential[],
  providerId: string,
  routedModel: string,
  context: {
    openAiPrefixed: boolean;
    localOllama: boolean;
    explicitOllama: boolean;
  },
  healthStore?: AccountHealthStore,
): ProviderCredential[] {
  return orderAccountsByPolicy(policy, providerId, accounts, routedModel, context, healthStore);
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
