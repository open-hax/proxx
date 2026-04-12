import type { ModelId, PlanType } from "../../schema.js";

export const PAID_PLAN_WEIGHTS: Record<PlanType, number> = {
  plus: 5,
  pro: 4,
  business: 4,
  enterprise: 4,
  team: 2,
  unknown: 1,
  free: 0,
};

export const PAID_PLANS: readonly PlanType[] = ["plus", "pro", "business", "enterprise", "team"];

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const GPT_FREE_BLOCKED_MODELS: readonly ModelId[] = [
  "gpt-5.3-codex",
  "gpt-5-mini",
];

export const GPT_FREE_BLOCKED_MODEL_PATTERN = new RegExp(
  `^(?:${GPT_FREE_BLOCKED_MODELS.map(escapeRegexLiteral).join("|")})$`,
);

export function buildFreeBlockedConstraints(
  models: readonly ModelId[],
): Record<ModelId, { readonly requiresPlan: PlanType[]; readonly excludesPlan: PlanType[] }> {
  const constraints: Record<ModelId, { readonly requiresPlan: PlanType[]; readonly excludesPlan: PlanType[] }> = {};
  for (const model of models) {
    constraints[model] = {
      requiresPlan: [...PAID_PLANS],
      excludesPlan: ["free"],
    };
  }
  return constraints;
}
