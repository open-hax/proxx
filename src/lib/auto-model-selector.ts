import { getModelPricing } from "./model-pricing.js";
import type { RequestLogStore } from "./request-log-store.js";
import type { AccountHealthStore } from "./db/account-health-store.js";

const AUTO_MODEL_PREFIX = "auto:";

export type AutoModelType = "cheapest" | "fastest" | "smartest" | "healthiest";

export interface RequestCapabilities {
  readonly needsVision: boolean;
  readonly needsTools: boolean;
  readonly needsThinking: boolean;
  readonly needsImages: boolean;
}

export interface ModelScore {
  readonly modelId: string;
  readonly providerId: string;
  readonly score: number;
  readonly costScore: number;
  readonly speedScore: number;
  readonly intelligenceScore: number;
  readonly healthScore: number;
  readonly pricingFound: boolean;
  readonly observedSpeed: boolean;
}

const MODEL_INTELLIGENCE_RANKING: ReadonlyMap<string, number> = new Map([
  ["gpt-5.4-pro", 100],
  ["gpt-5.4", 95],
  ["gpt-5.3-codex", 90],
  ["gpt-5.2-codex", 85],
  ["gpt-5.2", 80],
  ["gpt-5.1-codex-max", 88],
  ["gpt-5.1-codex", 82],
  ["gpt-5.1", 75],
  ["gpt-5-pro", 70],
  ["gpt-5", 65],
  ["gpt-5-mini", 50],
  ["gpt-5.4-mini", 55],
  ["gpt-5.4-nano", 30],
  ["claude-opus-4-6", 92],
  ["claude-opus-4-5", 90],
  ["claude-sonnet-4-6", 75],
  ["claude-sonnet-4-5", 72],
  ["claude-haiku-4-5", 45],
  ["gemini-2.5-pro", 85],
  ["gemini-2.5-flash", 50],
  ["gemini-3-pro-preview", 88],
  ["gemini-3-flash-preview", 52],
  ["glm-5", 70],
  ["deepseek-v3.2", 72],
  ["deepseek-chat", 65],
]);

const MODEL_VISION_SUPPORT: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "glm-5",
]);

const MODEL_TOOLS_SUPPORT: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "deepseek-v3.2",
  "glm-5",
]);

const MODEL_THINKING_SUPPORT: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "deepseek-v3.2",
  "deepseek-reasoner",
]);

function detectCapabilities(requestBody: unknown): RequestCapabilities {
  let needsVision = false;
  let needsTools = false;
  let needsThinking = false;
  let needsImages = false;

  if (!requestBody || typeof requestBody !== "object") {
    return { needsVision, needsTools, needsThinking, needsImages };
  }

  const body = requestBody as Record<string, unknown>;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      const message = msg as Record<string, unknown>;

      if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (!content || typeof content !== "object") continue;
          const c = content as Record<string, unknown>;
          if (c.type === "image_url") {
            needsVision = true;
          }
          if (c.type === "image_url" && typeof c.image_url === "object") {
            const url = c.image_url as Record<string, unknown>;
            if (typeof url.url === "string" && url.url.startsWith("data:image")) {
              needsImages = true;
            }
          }
        }
      }
    }
  }

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    needsTools = true;
  }

  if (
    typeof body.reasoning_effort === "string"
    || typeof body.reasoningEffort === "string"
    || typeof body.reasoning_summary === "string"
    || typeof body.reasoningSummary === "string"
  ) {
    needsThinking = true;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const reasoning = body.reasoning as Record<string, unknown>;
    if (reasoning.effort || reasoning.max_tokens) {
      needsThinking = true;
    }
  }

  return { needsVision, needsTools, needsThinking, needsImages };
}

function supportsVision(modelId: string): boolean {
  const normalized = modelId.toLowerCase().trim();
  return MODEL_VISION_SUPPORT.has(normalized) || MODEL_VISION_SUPPORT.has(normalized.replace(/-/g, "."));
}

function supportsTools(modelId: string): boolean {
  const normalized = modelId.toLowerCase().trim();
  return MODEL_TOOLS_SUPPORT.has(normalized) || MODEL_TOOLS_SUPPORT.has(normalized.replace(/-/g, "."));
}

function supportsThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase().trim();
  return MODEL_THINKING_SUPPORT.has(normalized) || MODEL_THINKING_SUPPORT.has(normalized.replace(/-/g, "."));
}

function getIntelligenceScore(modelId: string): number {
  const normalized = modelId.toLowerCase().trim();
  return MODEL_INTELLIGENCE_RANKING.get(normalized) ?? MODEL_INTELLIGENCE_RANKING.get(normalized.replace(/-/g, ".")) ?? 50;
}

export function isAutoModel(model: string): boolean {
  return model.toLowerCase().startsWith(AUTO_MODEL_PREFIX);
}

export function parseAutoModelType(model: string): AutoModelType | null {
  const normalized = model.toLowerCase().trim();
  if (!normalized.startsWith(AUTO_MODEL_PREFIX)) {
    return null;
  }
  const type = normalized.slice(AUTO_MODEL_PREFIX.length);
  if (type === "cheapest" || type === "fastest" || type === "smartest" || type === "healthiest") {
    return type;
  }
  return null;
}

const DEFAULT_CANDIDATE_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5-mini",
  "gpt-5",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "glm-5",
  "deepseek-v3.2",
];

export function selectAutoModel(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): string | null {
  return rankAutoModels(
    model,
    requestBody,
    availableModels,
    providerId,
    requestLogStore,
    accountHealthStore,
  )[0]?.modelId ?? null;
}

function compareModelScores(left: ModelScore, right: ModelScore, autoType: AutoModelType): number {
  switch (autoType) {
    case "cheapest": {
      if (left.pricingFound !== right.pricingFound) {
        return left.pricingFound ? -1 : 1;
      }
      if (left.costScore !== right.costScore) {
        return left.costScore - right.costScore;
      }
      if (left.healthScore !== right.healthScore) {
        return right.healthScore - left.healthScore;
      }
      if (left.intelligenceScore !== right.intelligenceScore) {
        return right.intelligenceScore - left.intelligenceScore;
      }
      return left.modelId.localeCompare(right.modelId);
    }
    case "fastest": {
      if (left.observedSpeed !== right.observedSpeed) {
        return left.observedSpeed ? -1 : 1;
      }
      if (left.speedScore !== right.speedScore) {
        return right.speedScore - left.speedScore;
      }
      if (left.healthScore !== right.healthScore) {
        return right.healthScore - left.healthScore;
      }
      return left.modelId.localeCompare(right.modelId);
    }
    case "smartest": {
      if (left.intelligenceScore !== right.intelligenceScore) {
        return right.intelligenceScore - left.intelligenceScore;
      }
      if (left.healthScore !== right.healthScore) {
        return right.healthScore - left.healthScore;
      }
      if (left.pricingFound !== right.pricingFound) {
        return left.pricingFound ? -1 : 1;
      }
      return left.costScore - right.costScore;
    }
    case "healthiest": {
      if (left.healthScore !== right.healthScore) {
        return right.healthScore - left.healthScore;
      }
      if (left.observedSpeed !== right.observedSpeed) {
        return left.observedSpeed ? -1 : 1;
      }
      if (left.speedScore !== right.speedScore) {
        return right.speedScore - left.speedScore;
      }
      return left.modelId.localeCompare(right.modelId);
    }
  }
}

export function rankAutoModels(
  model: string,
  requestBody: unknown,
  availableModels: readonly string[] | undefined,
  providerId: string,
  requestLogStore?: RequestLogStore,
  accountHealthStore?: AccountHealthStore,
): ModelScore[] {
  const autoType = parseAutoModelType(model);
  if (!autoType) {
    return [];
  }

  const capabilities = detectCapabilities(requestBody);

  const candidateModels = (availableModels ?? DEFAULT_CANDIDATE_MODELS).filter((m) => {
    if (isAutoModel(m)) return false;
    if (capabilities.needsVision && !supportsVision(m)) return false;
    if (capabilities.needsTools && !supportsTools(m)) return false;
    if (capabilities.needsThinking && !supportsThinking(m)) return false;
    return true;
  });

  if (candidateModels.length === 0) {
    return [];
  }

  const aggregateHealthScore = accountHealthStore
    ? (() => {
        const providerScores = accountHealthStore.getAllHealthScores()
          .filter((entry) => entry.providerId === providerId);
        if (providerScores.length === 0) {
          return 50;
        }

        const total = providerScores.reduce((sum, entry) => sum + entry.score, 0);
        return (total / providerScores.length) * 100;
      })()
    : 50;

  const scores: ModelScore[] = candidateModels.map((modelId) => {
    const pricing = getModelPricing(providerId, modelId);
    const costScore = pricing.inputPer1MTokens + pricing.outputPer1MTokens;

    let speedScore = 50;
    let observedSpeed = false;
    if (requestLogStore) {
      const perf = requestLogStore.getModelPerfSummary(providerId, modelId, "chat");
      if (perf?.ewmaTtftMs && perf.ewmaTtftMs > 0) {
        speedScore = Math.max(0, 100 - perf.ewmaTtftMs / 100);
        observedSpeed = true;
      }
    }

    const intelligenceScore = getIntelligenceScore(modelId);

    const healthScore = aggregateHealthScore;

    let overallScore: number;
    switch (autoType) {
      case "cheapest":
        overallScore = 100 - costScore;
        break;
      case "fastest":
        overallScore = speedScore;
        break;
      case "smartest":
        overallScore = intelligenceScore;
        break;
      case "healthiest":
        overallScore = healthScore;
        break;
    }

    return {
      modelId,
      providerId,
      score: overallScore,
      costScore,
      speedScore,
      intelligenceScore,
      healthScore,
      pricingFound: pricing.pricingFound,
      observedSpeed,
    };
  });

  scores.sort((left, right) => compareModelScores(left, right, autoType));

  return scores;
}
