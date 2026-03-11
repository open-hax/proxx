import type { ProviderCredential } from "./key-pool.js";
import type { PolicyEngine, AccountInfo, ModelInfo, PlanType } from "./policy/index.js";

function toPlanType(planType: string | undefined): PlanType {
  if (!planType) return "unknown";
  const normalized = planType.toLowerCase().trim();
  switch (normalized) {
    case "free":
      return "free";
    case "plus":
      return "plus";
    case "pro":
      return "pro";
    case "team":
      return "team";
    case "business":
      return "business";
    case "enterprise":
      return "enterprise";
    default:
      return "unknown";
  }
}

function toAccountInfo(credential: ProviderCredential): AccountInfo {
  const isExpired = credential.expiresAt !== undefined && Date.now() > credential.expiresAt;
  
  return {
    providerId: credential.providerId,
    accountId: credential.accountId,
    planType: toPlanType(credential.planType),
    authType: credential.authType,
    isExpired,
    isRateLimited: false,
  };
}

function toModelInfo(
  requestedModel: string,
  routedModel: string,
  context: {
    openAiPrefixed: boolean;
    localOllama: boolean;
    explicitOllama: boolean;
  },
): ModelInfo {
  const isGptModel = routedModel.startsWith("gpt-");
  
  return {
    requestedModel,
    routedModel,
    isGptModel,
    isOpenAiPrefixed: context.openAiPrefixed,
    isLocal: context.localOllama,
    isOllama: context.explicitOllama,
  };
}

export function orderAccountsByPolicy(
  policy: PolicyEngine,
  providerId: string,
  accounts: readonly ProviderCredential[],
  routedModel: string,
  context: {
    openAiPrefixed: boolean;
    localOllama: boolean;
    explicitOllama: boolean;
  },
): ProviderCredential[] {
  if (accounts.length === 0) {
    return [];
  }
  
  const modelInfo = toModelInfo(accounts[0]?.providerId ?? providerId, routedModel, context);
  const accountInfos = accounts.map(toAccountInfo);
  
  const result = policy.orderAccounts(providerId, accountInfos, modelInfo);
  
  const orderedIds = new Set(result.ordered.map((a) => a.accountId));
  const orderedCredentials: ProviderCredential[] = [];
  
  for (const info of result.ordered) {
    const credential = accounts.find((a: ProviderCredential) => a.accountId === info.accountId);
    if (credential) {
      orderedCredentials.push(credential);
    }
  }
  
  for (const credential of accounts) {
    if (!orderedIds.has(credential.accountId)) {
      orderedCredentials.push(credential);
    }
  }
  
  return orderedCredentials;
}

export function getPlanWeightsForModel(
  policy: PolicyEngine,
  modelId: string,
): Record<string, number> {
  const constraints = policy.getModelConstraints(modelId);
  const baseWeights = policy.getPlanWeights();
  
  if (constraints?.requiresPlan?.length) {
    const requiredPlans = new Set(constraints.requiresPlan);
    const adjusted: Record<string, number> = {};
    
    for (const [plan, weight] of Object.entries(baseWeights)) {
      const planKey = plan;
      const weightValue = weight;
      if (requiredPlans.has(planKey as PlanType)) {
        adjusted[planKey] = weightValue + 10;
      } else {
        adjusted[planKey] = weightValue - 5;
      }
    }
    
    return adjusted;
  }
  
  return { ...baseWeights };
}

export { toPlanType, toAccountInfo, toModelInfo };