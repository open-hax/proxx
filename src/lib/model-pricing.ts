import modelsDevPricingSnapshot from "./data/models-dev-pricing-data.js";

/**
 * Model pricing, energy, and environmental cost estimation.
 *
 * Prices come from a compact snapshot generated from https://models.dev/api.json.
 * Energy and water are still best-effort local heuristics.
 */

interface ModelsDevCost {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
}

interface ModelsDevProviderSnapshot {
  readonly models: Readonly<Record<string, ModelsDevCost>>;
}

interface ModelsDevSnapshot {
  readonly generatedAt: string;
  readonly sourceUrl: string;
  readonly providers: Readonly<Record<string, ModelsDevProviderSnapshot>>;
}

interface EnergyProfile {
  readonly joulesPerInputToken: number;
  readonly joulesPerOutputToken: number;
}

export interface ModelPricing {
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
  readonly reasoningPer1MTokens: number;
  readonly cacheReadPer1MTokens: number;
  readonly cacheWritePer1MTokens: number;
  readonly joulesPerInputToken: number;
  readonly joulesPerOutputToken: number;
  readonly pricingFound: boolean;
  readonly pricingSource: "models.dev" | "local" | "policy" | "unpriced";
  readonly pricingProviderId?: string;
  readonly pricingModelId?: string;
}

export interface RequestCostEstimate {
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

interface ModelsDevResolvedCost {
  readonly providerKey: string;
  readonly modelId: string;
  readonly cost: ModelsDevCost;
}

interface ModelsDevIndexedEntry extends ModelsDevResolvedCost {
  readonly aliases: readonly string[];
}

type FetchFn = typeof fetch;

export interface ModelPricingRefreshOptions {
  readonly sourceUrl?: string;
  readonly fetchFn?: FetchFn;
  readonly timeoutMs?: number;
}

export interface ModelPricingRefreshSchedulerOptions extends ModelPricingRefreshOptions {
  readonly intervalMs?: number;
  readonly initialRefresh?: boolean;
  readonly onRefresh?: (status: ModelPricingIndexStatus) => void;
  readonly onError?: (error: unknown) => void;
}

export interface ModelPricingRefreshHandle {
  refreshNow(): Promise<ModelPricingIndexStatus>;
  stop(): void;
}

export interface ModelPricingIndexStatus {
  readonly generatedAt: string;
  readonly sourceUrl: string;
  readonly providerCount: number;
  readonly modelCount: number;
}

const DEFAULT_MODELS_DEV_SOURCE_URL = "https://models.dev/api.json";
const DEFAULT_PRICING_REFRESH_TIMEOUT_MS = 10_000;

let activeModelsDevSnapshot = modelsDevPricingSnapshot as ModelsDevSnapshot;

// Default data center water use efficiency: ~1.8 L/kWh (scope-1 evaporative cooling average).
// Source: University of Illinois CEE, "AI's Challenging Waters" (2025).
const DC_WUE_ML_PER_KWH = Number(process.env.DC_WATER_USE_EFFICIENCY_ML_PER_KWH ?? "1800");
const JOULES_PER_KWH = 3_600_000;

const _ZERO_BILLING_COST: ModelsDevCost = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
};

const DEFAULT_ENERGY_PROFILE: EnergyProfile = {
  joulesPerInputToken: 0.5,
  joulesPerOutputToken: 1.5,
};

const ENERGY_RULES: ReadonlyArray<readonly [RegExp, EnergyProfile]> = [
  [/^gpt-5\.4$/, { joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/^gpt-5\.4-mini$/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/^gpt-5\.4-nano$/, { joulesPerInputToken: 0.1, joulesPerOutputToken: 0.3 }],
  [/^gpt-5\.3-codex/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.2-codex/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.2/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.1-codex-max/, { joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/^gpt-5\.1-codex/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5\.1/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/^gpt-5-mini/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/^gpt-5$/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-opus-4-6-fast/, { joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-opus-4-6/, { joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/claude-opus-4-5/, { joulesPerInputToken: 1.0, joulesPerOutputToken: 3.0 }],
  [/claude-opus-4-1/, { joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-opus-4/, { joulesPerInputToken: 1.5, joulesPerOutputToken: 4.0 }],
  [/claude-sonnet-4-6/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-sonnet-4-5/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-sonnet/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/claude-haiku-4-5/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/claude-haiku/, { joulesPerInputToken: 0.2, joulesPerOutputToken: 0.5 }],
  [/gemini-3\.1-pro/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-3-pro/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-3-flash/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/gemini-2\.5-pro/, { joulesPerInputToken: 0.8, joulesPerOutputToken: 2.5 }],
  [/gemini-2\.5-flash/, { joulesPerInputToken: 0.2, joulesPerOutputToken: 0.8 }],
  [/deepseek/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/glm-/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/kimi-/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/minimax/, { joulesPerInputToken: 0.3, joulesPerOutputToken: 1.0 }],
  [/^qwen/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^llama/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^gemma/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^mistral/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^devstral/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^ministral/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^nemotron/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^cogito/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^rnj-/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
  [/^gpt-oss/, { joulesPerInputToken: 0.05, joulesPerOutputToken: 0.15 }],
];

function stripRoutingPrefix(model: string): string {
  const slashIndex = model.indexOf("/");
  return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
}

function normalizeLookupModel(model: string): string {
  return stripRoutingPrefix(model).trim().toLowerCase();
}

function candidateAliasesForLookup(model: string): string[] {
  const candidates = new Set<string>();
  const normalized = normalizeLookupModel(model);
  const withoutLatest = normalized.replace(/:latest$/u, "");

  for (const candidate of [normalized, withoutLatest]) {
    if (candidate.length === 0) {
      continue;
    }
    candidates.add(candidate);
    candidates.add(candidate.replace(/:/gu, "-"));
  }

  // Some providers publish GLM variants with a `v` marker (for example `glm-5v-turbo`)
  // while models.dev only tracks the non-`v` form (for example `glm-5-turbo`).
  // Prefer pricing over "unpriced" for these known aliases.
  if (normalized.startsWith("glm-5v")) {
    const glm5 = normalized.replace(/^glm-5v(?=[-:])/, "glm-5").replace(/^glm-5v$/, "glm-5");
    if (glm5 !== normalized) {
      candidates.add(glm5);
      candidates.add(glm5.replace(/:/gu, "-"));
    }

    const glm5NoV = normalized.replace(/^glm-5v/, "glm-5");
    if (glm5NoV !== normalized) {
      candidates.add(glm5NoV);
      candidates.add(glm5NoV.replace(/:/gu, "-"));
    }
  }

  return [...candidates].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function aliasesForModelsDevModelId(modelId: string): string[] {
  const aliases = new Set<string>();
  const normalized = modelId.trim().toLowerCase();
  const parts = normalized.split("/");

  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join("/");
    if (suffix.length > 0) {
      aliases.add(suffix);
      aliases.add(suffix.replace(/:/gu, "-"));
    }
  }

  aliases.add(normalized);
  aliases.add(normalized.replace(/:/gu, "-"));
  return [...aliases].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

interface ModelsDevIndexes {
  readonly index: ReadonlyMap<string, readonly ModelsDevIndexedEntry[]>;
  readonly aliasIndex: ReadonlyMap<string, ReadonlyMap<string, ModelsDevIndexedEntry>>;
}

function buildModelsDevIndexes(snapshot: ModelsDevSnapshot): ModelsDevIndexes {
  const index = new Map<string, readonly ModelsDevIndexedEntry[]>();
  const aliasIndexByProvider = new Map<string, ReadonlyMap<string, ModelsDevIndexedEntry>>();

  for (const [providerKey, providerSnapshot] of Object.entries(snapshot.providers)) {
    const entries: ModelsDevIndexedEntry[] = [];
    const aliasIndex = new Map<string, ModelsDevIndexedEntry>();

    for (const [modelId, cost] of Object.entries(providerSnapshot.models)) {
      const entry: ModelsDevIndexedEntry = {
        providerKey,
        modelId,
        cost,
        aliases: aliasesForModelsDevModelId(modelId),
      };
      entries.push(entry);

      for (const alias of entry.aliases) {
        const existing = aliasIndex.get(alias);
        if (!existing || existing.modelId.length > entry.modelId.length) {
          aliasIndex.set(alias, entry);
        }
      }
    }

    index.set(providerKey, entries);
    aliasIndexByProvider.set(providerKey, aliasIndex);
  }

  return { index, aliasIndex: aliasIndexByProvider };
}

let modelsDevIndexes = buildModelsDevIndexes(activeModelsDevSnapshot);

// ─────────────────────────────────────────────────────────────────────────────
// Policy pricing overrides
//
// COMMANDMENT (do not violate):
// - Pricing overrides live in EDN policy contracts.
// - Do not add JSON pricing override blobs.
// - Do not add hard-coded TypeScript pricing tables for one-off models.
//
// The TS runtime may be fed overrides from the CLJS policy runtime.
// ─────────────────────────────────────────────────────────────────────────────

type PricingOverrideMode = "force" | "fallback-unpriced";

interface ModelPricingOverrideRule {
  readonly contractId: string;
  readonly modelPattern: RegExp;
  readonly providerPattern: RegExp | null;
  readonly mode: PricingOverrideMode;
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
  readonly reasoningPer1MTokens: number;
  readonly cacheReadPer1MTokens: number;
  readonly cacheWritePer1MTokens: number;
  readonly source?: string;
  readonly notes?: string;
}

let policyPricingOverrides: readonly ModelPricingOverrideRule[] = [];

function toFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseOverrideMode(value: unknown): PricingOverrideMode {
  if (value === "force" || value === ":force") {
    return "force";
  }
  return "fallback-unpriced";
}

function parseOverrideRule(value: unknown): ModelPricingOverrideRule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const contractId = typeof value.contractId === "string" ? value.contractId : "policy-override";
  const modelPatternRaw = typeof value.modelPattern === "string" ? value.modelPattern : null;
  if (!modelPatternRaw) {
    return undefined;
  }

  const providerPatternRaw = typeof value.providerPattern === "string" ? value.providerPattern : null;

  const input = toFiniteNonNegativeNumber(value.inputPer1MTokens);
  const output = toFiniteNonNegativeNumber(value.outputPer1MTokens);
  if (input === undefined || output === undefined) {
    return undefined;
  }

  const compileEdnRegex = (pattern: string): RegExp => {
    const trimmed = pattern.trim();
    const withoutInlineCaseFlag = trimmed.replace(/^\(\?iu\)/u, "").replace(/^\(\?ui\)/u, "").replace(/^\(\?i\)/u, "");
    return new RegExp(withoutInlineCaseFlag, "iu");
  };

  return {
    contractId,
    modelPattern: compileEdnRegex(modelPatternRaw),
    providerPattern: providerPatternRaw ? compileEdnRegex(providerPatternRaw) : null,
    mode: parseOverrideMode(value.mode),
    inputPer1MTokens: input,
    outputPer1MTokens: output,
    reasoningPer1MTokens: toFiniteNonNegativeNumber(value.reasoningPer1MTokens) ?? 0,
    cacheReadPer1MTokens: toFiniteNonNegativeNumber(value.cacheReadPer1MTokens) ?? 0,
    cacheWritePer1MTokens: toFiniteNonNegativeNumber(value.cacheWritePer1MTokens) ?? 0,
    source: typeof value.source === "string" ? value.source : undefined,
    notes: typeof value.notes === "string" ? value.notes : undefined,
  };
}

export function setPolicyModelPricingOverrides(overrides: unknown): void {
  if (!Array.isArray(overrides)) {
    policyPricingOverrides = [];
    return;
  }

  const parsed = overrides
    .map(parseOverrideRule)
    .filter((rule): rule is ModelPricingOverrideRule => rule !== undefined);

  policyPricingOverrides = parsed;
}

function resolvePolicyPricingOverride(providerId: string, model: string): ModelPricingOverrideRule | undefined {
  const normalizedProvider = providerId.trim().toLowerCase();
  const normalizedModel = normalizeLookupModel(model);

  for (const rule of policyPricingOverrides) {
    if (rule.providerPattern && !rule.providerPattern.test(normalizedProvider)) {
      continue;
    }
    if (!rule.modelPattern.test(normalizedModel)) {
      continue;
    }
    return rule;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactCost(rawCost: unknown): ModelsDevCost | undefined {
  if (!isRecord(rawCost)) {
    return undefined;
  }

  const cost: Record<string, number> = {};
  for (const key of ["input", "output", "reasoning", "cache_read", "cache_write"] as const) {
    const value = rawCost[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      cost[key] = value;
    }
  }

  return Object.keys(cost).length > 0 ? cost : undefined;
}

function rawCostFromModel(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return isRecord(value.cost) ? value.cost : value;
}

function compactModelsDevPricingSnapshot(rawPayload: unknown, generatedAt: string, sourceUrl: string): ModelsDevSnapshot {
  const rawRoot = isRecord(rawPayload) && isRecord(rawPayload.providers)
    ? rawPayload.providers
    : rawPayload;
  const providersRoot = isRecord(rawRoot) ? rawRoot : {};
  const providers: Record<string, ModelsDevProviderSnapshot> = {};

  const providerEntries = Object.entries(providersRoot).sort(([left], [right]) => left.localeCompare(right));
  for (const [providerId, provider] of providerEntries) {
    if (!isRecord(provider) || !isRecord(provider.models)) {
      continue;
    }

    const models: Record<string, ModelsDevCost> = {};
    const modelEntries = Object.entries(provider.models).sort(([left], [right]) => left.localeCompare(right));
    for (const [modelId, model] of modelEntries) {
      const cost = compactCost(rawCostFromModel(model));
      if (cost) {
        models[modelId] = cost;
      }
    }

    if (Object.keys(models).length > 0) {
      providers[providerId] = { models };
    }
  }

  if (Object.keys(providers).length === 0) {
    throw new Error("models.dev pricing payload did not contain any priced models");
  }

  return {
    generatedAt,
    sourceUrl,
    providers,
  };
}

function setModelsDevPricingSnapshot(snapshot: ModelsDevSnapshot): void {
  activeModelsDevSnapshot = snapshot;
  modelsDevIndexes = buildModelsDevIndexes(snapshot);
}

function countModelsDevModels(snapshot: ModelsDevSnapshot): number {
  return Object.values(snapshot.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
}

export function getModelPricingIndexStatus(): ModelPricingIndexStatus {
  return {
    generatedAt: activeModelsDevSnapshot.generatedAt,
    sourceUrl: activeModelsDevSnapshot.sourceUrl,
    providerCount: Object.keys(activeModelsDevSnapshot.providers).length,
    modelCount: countModelsDevModels(activeModelsDevSnapshot),
  };
}

export async function refreshModelsDevPricingIndex(options: ModelPricingRefreshOptions = {}): Promise<ModelPricingIndexStatus> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_MODELS_DEV_SOURCE_URL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("global fetch is not available; cannot refresh models.dev pricing index");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PRICING_REFRESH_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchFn(sourceUrl, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${sourceUrl}: ${response.status}`);
    }

    const payload: unknown = await response.json();
    const snapshot = compactModelsDevPricingSnapshot(payload, new Date().toISOString(), sourceUrl);
    setModelsDevPricingSnapshot(snapshot);
    return getModelPricingIndexStatus();
  } finally {
    clearTimeout(timeout);
  }
}

export function startModelsDevPricingRefresh(options: ModelPricingRefreshSchedulerOptions = {}): ModelPricingRefreshHandle {
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<ModelPricingIndexStatus> | undefined;

  const refreshNow = async (): Promise<ModelPricingIndexStatus> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = refreshModelsDevPricingIndex(options)
      .then((status) => {
        options.onRefresh?.(status);
        return status;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const scheduleNext = (): void => {
    if (stopped || intervalMs <= 0) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      void refreshNow().catch(() => undefined).finally(scheduleNext);
    }, intervalMs);
    timer.unref?.();
  };

  if (options.initialRefresh ?? true) {
    void refreshNow().catch(() => undefined).finally(scheduleNext);
  } else {
    scheduleNext();
  }

  return {
    refreshNow,
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function directModelsDevProviderKey(providerId: string): string | undefined {
  const normalized = providerId.trim().toLowerCase();
  switch (normalized) {
    case "gemini":
      return "google";
    case "local-ollama":
    case "ollama":
    case "local":
      return undefined;
    default:
      return modelsDevIndexes.index.has(normalized) ? normalized : undefined;
  }
}

function vendorFallbackProvidersForModel(model: string): readonly string[] {
  const normalized = normalizeLookupModel(model);

  if (normalized.startsWith("gpt-")) {
    return ["openai"];
  }
  if (normalized.startsWith("claude-")) {
    return ["anthropic"];
  }
  if (normalized.startsWith("gemini-")) {
    return ["google"];
  }
  if (normalized.startsWith("glm-")) {
    return ["zai"];
  }
  if (normalized.startsWith("deepseek")) {
    return ["deepseek"];
  }
  if (normalized.startsWith("kimi-")) {
    return ["moonshotai"];
  }
  if (normalized.startsWith("minimax")) {
    return ["minimax"];
  }
  if (normalized.startsWith("qwen")) {
    return ["alibaba"];
  }
  if (normalized.startsWith("mistral") || normalized.startsWith("devstral") || normalized.startsWith("ministral")) {
    return ["mistral"];
  }
  if (normalized.startsWith("gemma")) {
    return ["google"];
  }
  if (normalized.startsWith("nemotron")) {
    return ["nvidia"];
  }
  if (normalized.startsWith("llama")) {
    return ["meta"];
  }

  return [];
}

function preferredModelsDevProviders(providerId: string, model: string): string[] {
  const result: string[] = [];
  const direct = directModelsDevProviderKey(providerId);
  if (direct) {
    result.push(direct);
  }

  for (const providerKey of vendorFallbackProvidersForModel(model)) {
    if (!result.includes(providerKey) && modelsDevIndexes.index.has(providerKey)) {
      result.push(providerKey);
    }
  }

  return result;
}

function matchScore(entry: ModelsDevIndexedEntry, candidate: string): number {
  if (entry.aliases.includes(candidate)) {
    return 1_000 - entry.modelId.length;
  }

  for (const alias of entry.aliases) {
    if (alias.startsWith(`${candidate}-`)) {
      return 850 - alias.length;
    }
    if (alias.startsWith(candidate)) {
      return 750 - alias.length;
    }
    if (alias.includes(candidate)) {
      return 500 - alias.length;
    }
  }

  return Number.NEGATIVE_INFINITY;
}

function findModelsDevCost(providerKey: string, model: string): ModelsDevResolvedCost | undefined {
  const aliasIndex = modelsDevIndexes.aliasIndex.get(providerKey);
  const entries = modelsDevIndexes.index.get(providerKey);
  if (!aliasIndex || !entries) {
    return undefined;
  }

  const candidates = candidateAliasesForLookup(model);
  for (const candidate of candidates) {
    const exact = aliasIndex.get(candidate);
    if (exact) {
      return exact;
    }
  }

  let bestEntry: ModelsDevIndexedEntry | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    for (const candidate of candidates) {
      const score = matchScore(entry, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
  }

  return bestScore >= 400 ? bestEntry : undefined;
}

function resolveModelsDevCost(providerId: string, model: string): ModelsDevResolvedCost | undefined {
  for (const providerKey of preferredModelsDevProviders(providerId, model)) {
    const match = findModelsDevCost(providerKey, model);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function resolveEnergyProfile(model: string): EnergyProfile {
  const normalized = normalizeLookupModel(model);
  for (const [pattern, profile] of ENERGY_RULES) {
    if (pattern.test(normalized)) {
      return profile;
    }
  }
  return DEFAULT_ENERGY_PROFILE;
}

export function getModelPricing(providerId: string, model: string): ModelPricing {
  const energyProfile = resolveEnergyProfile(model);
  const normalizedProvider = providerId.trim().toLowerCase();

  if (normalizedProvider === "ollama" || normalizedProvider === "local-ollama" || normalizedProvider === "local") {
    return {
      inputPer1MTokens: 0,
      outputPer1MTokens: 0,
      reasoningPer1MTokens: 0,
      cacheReadPer1MTokens: 0,
      cacheWritePer1MTokens: 0,
      ...energyProfile,
      pricingFound: true,
      pricingSource: "local",
    };
  }

  const policyOverride = resolvePolicyPricingOverride(providerId, model);

  const resolved = resolveModelsDevCost(providerId, model);
  if (!resolved) {
    if (policyOverride && policyOverride.mode !== "force") {
      return {
        inputPer1MTokens: policyOverride.inputPer1MTokens,
        outputPer1MTokens: policyOverride.outputPer1MTokens,
        reasoningPer1MTokens: policyOverride.reasoningPer1MTokens,
        cacheReadPer1MTokens: policyOverride.cacheReadPer1MTokens,
        cacheWritePer1MTokens: policyOverride.cacheWritePer1MTokens,
        ...energyProfile,
        pricingFound: true,
        pricingSource: "policy",
        pricingProviderId: "policy",
        pricingModelId: normalizeLookupModel(model),
      };
    }

    return {
      inputPer1MTokens: 0,
      outputPer1MTokens: 0,
      reasoningPer1MTokens: 0,
      cacheReadPer1MTokens: 0,
      cacheWritePer1MTokens: 0,
      ...energyProfile,
      pricingFound: false,
      pricingSource: "unpriced",
    };
  }

  if (policyOverride && policyOverride.mode === "force") {
    return {
      inputPer1MTokens: policyOverride.inputPer1MTokens,
      outputPer1MTokens: policyOverride.outputPer1MTokens,
      reasoningPer1MTokens: policyOverride.reasoningPer1MTokens,
      cacheReadPer1MTokens: policyOverride.cacheReadPer1MTokens,
      cacheWritePer1MTokens: policyOverride.cacheWritePer1MTokens,
      ...energyProfile,
      pricingFound: true,
      pricingSource: "policy",
      pricingProviderId: "policy",
      pricingModelId: normalizeLookupModel(model),
    };
  }

  const cost = resolved.cost;
  return {
    inputPer1MTokens: cost.input ?? 0,
    outputPer1MTokens: cost.output ?? 0,
    reasoningPer1MTokens: cost.reasoning ?? 0,
    cacheReadPer1MTokens: cost.cache_read ?? 0,
    cacheWritePer1MTokens: cost.cache_write ?? 0,
    ...energyProfile,
    pricingFound: true,
    pricingSource: "models.dev",
    pricingProviderId: resolved.providerKey,
    pricingModelId: resolved.modelId,
  };
}

export function estimateRequestCost(
  providerId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): RequestCostEstimate {
  const pricing = getModelPricing(providerId, model);

  const costUsd =
    (promptTokens * pricing.inputPer1MTokens) / 1_000_000 +
    (completionTokens * pricing.outputPer1MTokens) / 1_000_000;

  const energyJoules =
    promptTokens * pricing.joulesPerInputToken +
    completionTokens * pricing.joulesPerOutputToken;

  const waterEvaporatedMl = (energyJoules / JOULES_PER_KWH) * DC_WUE_ML_PER_KWH;

  return { costUsd, energyJoules, waterEvaporatedMl };
}
