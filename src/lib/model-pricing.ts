/**
 * Model pricing, energy, and environmental cost estimation.
 *
 * Prices: USD per 1M tokens (input/output), from official API pricing pages (March 2026).
 * Energy: Joules per token, estimated from published benchmarks and research papers.
 * Water: Milliliters evaporated per kWh of data center energy (scope-1 cooling).
 *
 * All values are best-effort approximations. Actual costs depend on provider,
 * billing tier, caching, and data center cooling infrastructure.
 */

export interface ModelPricing {
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
  readonly joulesPerInputToken: number;
  readonly joulesPerOutputToken: number;
}

export interface RequestCostEstimate {
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

// Default data center water use efficiency: ~1.8 L/kWh (scope-1 evaporative cooling average).
// Source: University of Illinois CEE, "AI's Challenging Waters" (2025).
const DC_WUE_ML_PER_KWH = Number(process.env.DC_WATER_USE_EFFICIENCY_ML_PER_KWH ?? "1800");

const JOULES_PER_KWH = 3_600_000;

// --- Pricing rules: array of (pattern, pricing) tuples, first match wins ---
// Patterns are tested against the lowercased model ID.

const PRICING_RULES: ReadonlyArray<readonly [RegExp, ModelPricing]> = [
  // ── OpenAI GPT-5.4 ──
  [/^gpt-5\.4$/, { inputPer1MTokens: 2.50, outputPer1MTokens: 15.00, joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/^gpt-5\.4-mini$/, { inputPer1MTokens: 0.75, outputPer1MTokens: 4.50, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/^gpt-5\.4-nano$/, { inputPer1MTokens: 0.20, outputPer1MTokens: 1.25, joulesPerInputToken: 0.1, joulesPerOutputToken: 0.3 }],

  // ── OpenAI GPT-5.x family (5, 5.1, 5.2, 5.3 codex variants) ──
  [/^gpt-5\.3-codex/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.2-codex/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.2/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.1-codex-max/, { inputPer1MTokens: 5.00, outputPer1MTokens: 20.00, joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/^gpt-5\.1-codex/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.1/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5-mini/, { inputPer1MTokens: 0.75, outputPer1MTokens: 3.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/^gpt-5$/, { inputPer1MTokens: 2.50, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],

  // ── Anthropic Claude (via Factory or direct) ──
  [/claude-opus-4-6-fast/, { inputPer1MTokens: 30.00, outputPer1MTokens: 150.00, joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-opus-4-6/, { inputPer1MTokens: 5.00, outputPer1MTokens: 25.00, joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/claude-opus-4-5/, { inputPer1MTokens: 5.00, outputPer1MTokens: 25.00, joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/claude-opus-4-1/, { inputPer1MTokens: 15.00, outputPer1MTokens: 75.00, joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-opus-4/, { inputPer1MTokens: 15.00, outputPer1MTokens: 75.00, joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-sonnet-4-6/, { inputPer1MTokens: 3.00, outputPer1MTokens: 15.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-sonnet-4-5/, { inputPer1MTokens: 3.00, outputPer1MTokens: 15.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-sonnet/, { inputPer1MTokens: 3.00, outputPer1MTokens: 15.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-haiku-4-5/, { inputPer1MTokens: 1.00, outputPer1MTokens: 5.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/claude-haiku/, { inputPer1MTokens: 0.25, outputPer1MTokens: 1.25, joulesPerInputToken: 0.2, joulesPerOutputToken: 0.5 }],

  // ── Google Gemini ──
  [/gemini-3\.1-pro/, { inputPer1MTokens: 2.00, outputPer1MTokens: 12.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-3-pro/, { inputPer1MTokens: 2.00, outputPer1MTokens: 12.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-3-flash/, { inputPer1MTokens: 0.50, outputPer1MTokens: 3.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/gemini-2\.5-pro/, { inputPer1MTokens: 1.25, outputPer1MTokens: 10.00, joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-2\.5-flash/, { inputPer1MTokens: 0.30, outputPer1MTokens: 2.50, joulesPerInputToken: 0.2, joulesPerOutputToken: 0.8 }],

  // ── DeepSeek ──
  [/deepseek/, { inputPer1MTokens: 0.27, outputPer1MTokens: 1.10, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],

  // ── GLM (Zhipu) ──
  [/glm-/, { inputPer1MTokens: 0.50, outputPer1MTokens: 2.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],

  // ── Kimi (Moonshot) ──
  [/kimi-/, { inputPer1MTokens: 0.50, outputPer1MTokens: 2.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],

  // ── MiniMax ──
  [/minimax/, { inputPer1MTokens: 0.50, outputPer1MTokens: 2.00, joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],

  // ── Local Ollama models (air-cooled desktop, near-zero water) ──
  [/^qwen/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^llama/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^gemma/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^mistral/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^devstral/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^ministral/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^nemotron/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^cogito/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^rnj-/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^gpt-oss/, { inputPer1MTokens: 0, outputPer1MTokens: 0, joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
];

const DEFAULT_PRICING: ModelPricing = {
  inputPer1MTokens: 1.00,
  outputPer1MTokens: 5.00,
  joulesPerInputToken: 0.5,
  joulesPerOutputToken: 1.5,
};

/**
 * Strip provider routing prefixes (factory/, ollama/, openai/) from a model ID
 * before matching against pricing rules.
 */
function stripRoutingPrefix(model: string): string {
  const slashIndex = model.indexOf("/");
  return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
}

/**
 * Look up pricing for a model. Strips provider routing prefixes first,
 * then matches against the pricing rules table (first match wins).
 */
export function getModelPricing(model: string): ModelPricing {
  const stripped = stripRoutingPrefix(model).toLowerCase();
  for (const [pattern, pricing] of PRICING_RULES) {
    if (pattern.test(stripped)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

/**
 * Estimate the cost, energy, and water evaporation for a single request.
 */
export function estimateRequestCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): RequestCostEstimate {
  const pricing = getModelPricing(model);

  const costUsd =
    (promptTokens * pricing.inputPer1MTokens) / 1_000_000 +
    (completionTokens * pricing.outputPer1MTokens) / 1_000_000;

  const energyJoules =
    promptTokens * pricing.joulesPerInputToken +
    completionTokens * pricing.joulesPerOutputToken;

  const waterEvaporatedMl = (energyJoules / JOULES_PER_KWH) * DC_WUE_ML_PER_KWH;

  return { costUsd, energyJoules, waterEvaporatedMl };
}
