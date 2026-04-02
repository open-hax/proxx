export type ModelFamily =
  | "openai"
  | "anthropic"
  | "google"
  | "zhipu"
  | "deepseek"
  | "moonshotai"
  | "qwen";

interface FamilyRule {
  readonly family: ModelFamily;
  readonly prefixes: readonly string[];
  /** Provider name used for Requesty-style upstream mapping. */
  readonly requestyProvider: string;
}

const MODEL_FAMILY_RULES: readonly FamilyRule[] = [
  { family: "openai", prefixes: ["gpt-", "chatgpt-", "o1", "o3", "o4", "o1-", "o3-", "o4-"], requestyProvider: "openai" },
  { family: "anthropic", prefixes: ["claude-"], requestyProvider: "anthropic" },
  { family: "google", prefixes: ["gemini-"], requestyProvider: "google" },
  { family: "zhipu", prefixes: ["glm-"], requestyProvider: "zhipu" },
  { family: "deepseek", prefixes: ["deepseek"], requestyProvider: "deepseek" },
  { family: "moonshotai", prefixes: ["kimi-"], requestyProvider: "moonshotai" },
  { family: "qwen", prefixes: ["qwen"], requestyProvider: "qwen" },
];

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function matchesPrefix(normalized: string, prefix: string): boolean {
  if (prefix.length > 0 && prefix.endsWith("-")) {
    return normalized.startsWith(prefix) || normalized === prefix.slice(0, -1);
  }
  return normalized.startsWith(prefix) || normalized === prefix;
}

export function inferModelFamily(modelId: string): ModelFamily | undefined {
  const normalized = normalizeModelId(modelId);
  for (const rule of MODEL_FAMILY_RULES) {
    if (rule.prefixes.some((p) => matchesPrefix(normalized, p))) {
      return rule.family;
    }
  }
  return undefined;
}

export function looksLikeHostedOpenAiFamily(modelId: string): boolean {
  return inferModelFamily(modelId) === "openai";
}

export function requestyModelProvider(modelId: string): string {
  const normalized = normalizeModelId(modelId);
  for (const rule of MODEL_FAMILY_RULES) {
    if (rule.prefixes.some((p) => matchesPrefix(normalized, p))) {
      return rule.requestyProvider;
    }
  }
  return "openai";
}
