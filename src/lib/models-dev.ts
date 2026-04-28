import embeddedPricingSnapshot from "./data/models-dev-pricing-data.js";

/**
 * models.dev integration.
 *
 * Upstream reference:
 * - https://models.dev/api.json
 * - https://models.dev/logos/{provider}.svg
 *
 * We keep an embedded snapshot for cold-start/offline operation, but attempt to
 * refresh it opportunistically at runtime.
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

export interface ModelsDevPricingSnapshot {
  readonly generatedAt: string;
  readonly sourceUrl: string;
  readonly providers: Readonly<Record<string, ModelsDevProviderSnapshot>>;
}

export interface ModelsDevProviderDescriptor {
  readonly providerId: string;
  readonly name?: string;
  readonly apiBaseUrl?: string;
  readonly env?: readonly string[];
  readonly doc?: string;
  readonly logoUrl: string;
}

type ModelsDevApiModel = {
  readonly id?: unknown;
  readonly cost?: unknown;
};

type ModelsDevApiProvider = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly api?: unknown;
  readonly env?: unknown;
  readonly doc?: unknown;
  readonly models?: unknown;
};

type ModelsDevApiJson = Record<string, ModelsDevApiProvider>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value
    .map((entry) => asString(entry)?.trim())
    .filter((entry): entry is string => Boolean(entry && entry.length > 0));
  return result.length > 0 ? result : undefined;
}

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

function logoUrlForProvider(providerId: string): string {
  return `https://models.dev/logos/${encodeURIComponent(normalizeProviderId(providerId))}.svg`;
}

function parseModelsDevCost(raw: unknown): ModelsDevCost {
  if (!isRecord(raw)) {
    return {};
  }

  return {
    input: asNumber(raw.input),
    output: asNumber(raw.output),
    reasoning: asNumber(raw.reasoning),
    cache_read: asNumber(raw.cache_read ?? raw.cacheRead),
    cache_write: asNumber(raw.cache_write ?? raw.cacheWrite),
  };
}

function buildPricingSnapshotFromApi(api: ModelsDevApiJson): ModelsDevPricingSnapshot {
  const providers: Record<string, ModelsDevProviderSnapshot> = {};

  for (const [providerKey, rawProvider] of Object.entries(api)) {
    const normalizedProviderKey = normalizeProviderId(providerKey);
    const models: Record<string, ModelsDevCost> = {};

    const rawModels = isRecord(rawProvider?.models) ? rawProvider.models : null;
    if (!rawModels) {
      continue;
    }

    for (const [modelId, rawModel] of Object.entries(rawModels)) {
      const modelRecord = isRecord(rawModel) ? (rawModel as ModelsDevApiModel) : null;
      const cost = parseModelsDevCost(isRecord(modelRecord?.cost) ? modelRecord.cost : undefined);
      // Keep entries even when cost is empty; presence still helps model->provider lookups.
      models[String(modelId)] = cost;
    }

    if (Object.keys(models).length > 0) {
      providers[normalizedProviderKey] = { models };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceUrl: "https://models.dev/api.json",
    providers,
  };
}

function parseProviderDescriptors(api: ModelsDevApiJson): ModelsDevProviderDescriptor[] {
  const descriptors: ModelsDevProviderDescriptor[] = [];

  for (const [providerKey, rawProvider] of Object.entries(api)) {
    const normalizedProviderId = normalizeProviderId(providerKey);
    if (normalizedProviderId.length === 0) {
      continue;
    }

    const apiBaseUrl = asString(rawProvider.api)?.trim().replace(/\/+$/, "") || undefined;
    descriptors.push({
      providerId: normalizedProviderId,
      name: asString(rawProvider.name)?.trim() || undefined,
      apiBaseUrl,
      env: readStringArray(rawProvider.env),
      doc: asString(rawProvider.doc)?.trim() || undefined,
      logoUrl: logoUrlForProvider(normalizedProviderId),
    });
  }

  descriptors.sort((left, right) => left.providerId.localeCompare(right.providerId));
  return descriptors;
}

const EMBEDDED_SNAPSHOT = embeddedPricingSnapshot as ModelsDevPricingSnapshot;

let liveSnapshot: ModelsDevPricingSnapshot | null = null;
let liveProviders: ModelsDevProviderDescriptor[] | null = null;
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

function refreshTtlMs(): number {
  const raw = Number(process.env.MODELS_DEV_API_TTL_MS ?? "21600000"); // 6h
  return Number.isFinite(raw) ? Math.max(raw, 5_000) : 21_600_000;
}

async function refreshModelsDevApiJson(): Promise<void> {
  const timeoutMs = Number(process.env.MODELS_DEV_API_TIMEOUT_MS ?? "12000");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 12_000);

  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`models.dev api.json returned ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("models.dev api.json payload was not an object");
    }

    const api = json as ModelsDevApiJson;
    liveSnapshot = buildPricingSnapshotFromApi(api);
    liveProviders = parseProviderDescriptors(api);
    lastRefreshAt = Date.now();
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleRefreshIfStale(): void {
  const ttl = refreshTtlMs();
  const now = Date.now();
  if (now - lastRefreshAt < ttl) {
    return;
  }
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = refreshModelsDevApiJson()
    .catch(() => {
      // Ignore refresh failures; embedded snapshot remains available.
    })
    .finally(() => {
      refreshInFlight = null;
    });
}

export function getModelsDevPricingSnapshot(): ModelsDevPricingSnapshot {
  scheduleRefreshIfStale();
  return liveSnapshot ?? EMBEDDED_SNAPSHOT;
}

export async function forceRefreshModelsDevPricingSnapshot(): Promise<void> {
  await (refreshInFlight ?? Promise.resolve());
  await refreshModelsDevApiJson();
}

export function getModelsDevProviderDescriptors(): readonly ModelsDevProviderDescriptor[] {
  scheduleRefreshIfStale();
  return liveProviders ?? [];
}

export function modelsDevLogoUrl(providerId: string): string {
  return logoUrlForProvider(providerId);
}

function normalizeModelForLookup(model: string): string {
  return model.trim().toLowerCase();
}

function stripRoutingPrefix(model: string): string {
  const slashIndex = model.indexOf("/");
  return slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
}

function candidateModelAliases(model: string): string[] {
  const normalized = normalizeModelForLookup(model);
  const stripped = normalizeModelForLookup(stripRoutingPrefix(model));
  const withoutLatest = stripped.replace(/:latest$/u, "");

  const candidates = new Set<string>();
  for (const entry of [normalized, stripped, withoutLatest]) {
    if (!entry) {
      continue;
    }
    candidates.add(entry);
    candidates.add(entry.replace(/:/gu, "-"));
  }
  return [...candidates].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export interface ModelsDevProviderModelMatch {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * Best-effort provider lookup for an arbitrary model string.
 *
 * We attempt exact and suffix matches so that e.g. "gpt-4.1" can match provider
 * model IDs like "openai/gpt-4.1".
 */
export function findModelsDevProvidersForModel(model: string): readonly ModelsDevProviderModelMatch[] {
  const snapshot = getModelsDevPricingSnapshot();
  const matches: ModelsDevProviderModelMatch[] = [];
  const candidates = candidateModelAliases(model);

  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    const modelEntries = Object.keys(provider.models);
    if (modelEntries.length === 0) {
      continue;
    }

    for (const rawModelId of modelEntries) {
      const modelId = normalizeModelForLookup(rawModelId);
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        if (modelId === candidate || modelId.endsWith(`/${candidate}`)) {
          matches.push({ providerId, modelId: rawModelId });
          break;
        }
      }
    }
  }

  const seen = new Set<string>();
  const unique = matches.filter((entry) => {
    const key = `${entry.providerId}\0${entry.modelId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  return unique;
}
