import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { estimateRequestCost } from "./model-pricing.js";

export type RequestAuthType = "api_key" | "oauth_bearer" | "local" | "none";
export type RequestServiceTierSource = "fast_mode" | "explicit" | "none";

export interface Factory4xxDiagnostics {
  readonly promptCacheKeyHash?: string;
  readonly requestFormat: "responses" | "messages" | "chat_completions" | "unknown";
  readonly messageCount?: number;
  readonly inputItemCount?: number;
  readonly systemMessageCount?: number;
  readonly userMessageCount?: number;
  readonly assistantMessageCount?: number;
  readonly toolMessageCount?: number;
  readonly functionCallCount?: number;
  readonly functionCallOutputCount?: number;
  readonly imageInputCount?: number;
  readonly hasInstructions?: boolean;
  readonly instructionsChars?: number;
  readonly totalTextChars?: number;
  readonly maxTextBlockChars?: number;
  readonly hasReasoning?: boolean;
  readonly hasCodeFence?: boolean;
  readonly hasXmlLikeTags?: boolean;
  readonly hasOpencodeMarkers?: boolean;
  readonly hasAgentProtocolMarkers?: boolean;
  readonly textFingerprint?: string;
  readonly instructionsFingerprint?: string;
}

export interface RequestLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly model: string;
  readonly upstreamMode: string;
  readonly upstreamPath: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly serviceTier?: string;
  readonly serviceTierSource: RequestServiceTierSource;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly error?: string;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
  readonly factoryDiagnostics?: Factory4xxDiagnostics;
  readonly costUsd?: number;
  readonly energyJoules?: number;
  readonly waterEvaporatedMl?: number;
}

export interface RequestLogFilters {
  readonly providerId?: string;
  readonly accountId?: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface RequestLogRecordInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly model: string;
  readonly upstreamMode: string;
  readonly upstreamPath: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly serviceTier?: string;
  readonly serviceTierSource?: RequestServiceTierSource;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly imageCount?: number;
  readonly imageCostUsd?: number;
  readonly promptCacheKeyUsed?: boolean;
  readonly cacheHit?: boolean;
  readonly ttftMs?: number;
  readonly tps?: number;
  readonly error?: string;
  readonly upstreamErrorCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamErrorMessage?: string;
  readonly factoryDiagnostics?: Factory4xxDiagnostics;
  readonly costUsd?: number;
  readonly energyJoules?: number;
  readonly waterEvaporatedMl?: number;
  readonly timestamp?: number;
}

export interface RequestLogHourlyBucket {
  readonly startMs: number;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyBucket {
  readonly startMs: number;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyModelBucket {
  readonly startMs: number;
  readonly providerId: string;
  readonly model: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogDailyAccountBucket {
  readonly startMs: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly fastModeRequestCount: number;
  readonly priorityRequestCount: number;
  readonly standardRequestCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogCoverage {
  readonly earliestEntryAtMs: number | null;
  readonly earliestHourlyBucketAtMs: number | null;
  readonly earliestDailyBucketAtMs: number | null;
  readonly earliestModelBreakdownAtMs: number | null;
  readonly earliestAccountBreakdownAtMs: number | null;
  readonly retainedEntryCount: number;
  readonly maxEntries: number;
}

export interface AccountUsageAccumulator {
  readonly providerId: string;
  readonly accountId: string;
  readonly authType: RequestAuthType;
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly imageCount: number;
  readonly imageCostUsd: number;
  readonly cacheHitCount: number;
  readonly cacheKeyUseCount: number;
  readonly ttftSum: number;
  readonly ttftCount: number;
  readonly tpsSum: number;
  readonly tpsCount: number;
  readonly lastUsedAtMs: number;
  readonly costUsd: number;
  readonly energyJoules: number;
  readonly waterEvaporatedMl: number;
}

export interface RequestLogPerfSummary {
  readonly providerId: string;
  readonly accountId: string;
  readonly model: string;
  readonly upstreamMode: string;
  readonly sampleCount: number;
  readonly ewmaTtftMs: number;
  readonly ewmaTps: number | null;
  readonly updatedAt: number;
}

interface RequestLogDb {
  readonly entries: RequestLogEntry[];
  readonly hourlyBuckets?: readonly RequestLogHourlyBucket[];
  readonly dailyBuckets?: readonly RequestLogDailyBucket[];
  readonly dailyModelBuckets?: readonly RequestLogDailyModelBucket[];
  readonly dailyAccountBuckets?: readonly RequestLogDailyAccountBucket[];
  readonly accountAccumulators?: readonly AccountUsageAccumulator[];
}

type HourlyBucket = {
  startMs: number;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  imageCount: number;
  imageCostUsd: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  fastModeRequestCount: number;
  priorityRequestCount: number;
  standardRequestCount: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
};

type DailyBucket = {
  startMs: number;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  imageCount: number;
  imageCostUsd: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  fastModeRequestCount: number;
  priorityRequestCount: number;
  standardRequestCount: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
};

type DailyModelBucket = {
  startMs: number;
  providerId: string;
  model: string;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  imageCount: number;
  imageCostUsd: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  fastModeRequestCount: number;
  priorityRequestCount: number;
  standardRequestCount: number;
  ttftSum: number;
  ttftCount: number;
  tpsSum: number;
  tpsCount: number;
  lastUsedAtMs: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
};

type DailyAccountBucket = {
  startMs: number;
  providerId: string;
  accountId: string;
  authType: RequestAuthType;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  imageCount: number;
  imageCostUsd: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  fastModeRequestCount: number;
  priorityRequestCount: number;
  standardRequestCount: number;
  ttftSum: number;
  ttftCount: number;
  tpsSum: number;
  tpsCount: number;
  lastUsedAtMs: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
};

type PerfIndexEntry = {
  providerId: string;
  accountId: string;
  model: string;
  upstreamMode: string;
  sampleCount: number;
  ewmaTtftMs: number;
  ewmaTps: number | null;
  updatedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeOptionalCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value >= 0 ? value : undefined;
}

function sanitizeOptionalCost(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value >= 0 ? value : undefined;
}

function sanitizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeOptionalShortString(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function hydrateFactoryDiagnostics(raw: unknown): Factory4xxDiagnostics | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const requestFormatRaw = asString(raw.requestFormat);
  const requestFormat: Factory4xxDiagnostics["requestFormat"] =
    requestFormatRaw === "responses"
    || requestFormatRaw === "messages"
    || requestFormatRaw === "chat_completions"
    || requestFormatRaw === "unknown"
      ? requestFormatRaw
      : "unknown";

  const diagnostics: Factory4xxDiagnostics = {
    requestFormat,
    promptCacheKeyHash: sanitizeOptionalShortString(raw.promptCacheKeyHash, 80),
    messageCount: sanitizeOptionalCount(asNumber(raw.messageCount)),
    inputItemCount: sanitizeOptionalCount(asNumber(raw.inputItemCount)),
    systemMessageCount: sanitizeOptionalCount(asNumber(raw.systemMessageCount)),
    userMessageCount: sanitizeOptionalCount(asNumber(raw.userMessageCount)),
    assistantMessageCount: sanitizeOptionalCount(asNumber(raw.assistantMessageCount)),
    toolMessageCount: sanitizeOptionalCount(asNumber(raw.toolMessageCount)),
    functionCallCount: sanitizeOptionalCount(asNumber(raw.functionCallCount)),
    functionCallOutputCount: sanitizeOptionalCount(asNumber(raw.functionCallOutputCount)),
    imageInputCount: sanitizeOptionalCount(asNumber(raw.imageInputCount)),
    hasInstructions: sanitizeOptionalBoolean(raw.hasInstructions),
    instructionsChars: sanitizeOptionalCount(asNumber(raw.instructionsChars)),
    totalTextChars: sanitizeOptionalCount(asNumber(raw.totalTextChars)),
    maxTextBlockChars: sanitizeOptionalCount(asNumber(raw.maxTextBlockChars)),
    hasReasoning: sanitizeOptionalBoolean(raw.hasReasoning),
    hasCodeFence: sanitizeOptionalBoolean(raw.hasCodeFence),
    hasXmlLikeTags: sanitizeOptionalBoolean(raw.hasXmlLikeTags),
    hasOpencodeMarkers: sanitizeOptionalBoolean(raw.hasOpencodeMarkers),
    hasAgentProtocolMarkers: sanitizeOptionalBoolean(raw.hasAgentProtocolMarkers),
    textFingerprint: sanitizeOptionalShortString(raw.textFingerprint, 80),
    instructionsFingerprint: sanitizeOptionalShortString(raw.instructionsFingerprint, 80),
  };

  const hasSignal = diagnostics.promptCacheKeyHash !== undefined
    || diagnostics.messageCount !== undefined
    || diagnostics.inputItemCount !== undefined
    || diagnostics.systemMessageCount !== undefined
    || diagnostics.userMessageCount !== undefined
    || diagnostics.assistantMessageCount !== undefined
    || diagnostics.toolMessageCount !== undefined
    || diagnostics.functionCallCount !== undefined
    || diagnostics.functionCallOutputCount !== undefined
    || diagnostics.imageInputCount !== undefined
    || diagnostics.hasInstructions !== undefined
    || diagnostics.instructionsChars !== undefined
    || diagnostics.totalTextChars !== undefined
    || diagnostics.maxTextBlockChars !== undefined
    || diagnostics.hasReasoning !== undefined
    || diagnostics.hasCodeFence !== undefined
    || diagnostics.hasXmlLikeTags !== undefined
    || diagnostics.hasOpencodeMarkers !== undefined
    || diagnostics.hasAgentProtocolMarkers !== undefined
    || diagnostics.textFingerprint !== undefined
    || diagnostics.instructionsFingerprint !== undefined
    || diagnostics.requestFormat !== "unknown";

  return hasSignal ? diagnostics : undefined;
}

function emptyDb(): RequestLogDb {
  return {
    entries: [],
    hourlyBuckets: [],
    dailyBuckets: [],
    dailyModelBuckets: [],
    dailyAccountBuckets: [],
    accountAccumulators: [],
  };
}

function buildTempFilePath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function buildCorruptFilePath(filePath: string): string {
  return join(dirname(filePath), `${basename(filePath)}.corrupt-${Date.now()}-${process.pid}-${crypto.randomUUID()}`);
}

function hydrateEntry(raw: unknown): RequestLogEntry | null {
  if (!isRecord(raw)) {
    return null;
  }

  const providerId = asString(raw.providerId)?.trim();
  const accountId = asString(raw.accountId)?.trim();
  const authType = raw.authType;
  const model = asString(raw.model)?.trim();
  const upstreamMode = asString(raw.upstreamMode)?.trim();
  const upstreamPath = asString(raw.upstreamPath)?.trim();
  const status = asNumber(raw.status);
  const latencyMs = asNumber(raw.latencyMs);
  const serviceTier = asString(raw.serviceTier)?.trim();
  const serviceTierSource = raw.serviceTierSource;

  if (!providerId || !accountId || !model || !upstreamMode || !upstreamPath || status === undefined || latencyMs === undefined) {
    return null;
  }

  const normalizedAuthType: RequestAuthType =
    authType === "api_key" || authType === "oauth_bearer" || authType === "local" || authType === "none"
      ? authType
      : "none";

  const normalizedServiceTierSource: RequestServiceTierSource =
    serviceTierSource === "fast_mode" || serviceTierSource === "explicit" || serviceTierSource === "none"
      ? serviceTierSource
      : serviceTier
        ? "explicit"
        : "none";

  return {
    id: asString(raw.id) ?? crypto.randomUUID(),
    timestamp: asNumber(raw.timestamp) ?? Date.now(),
    providerId,
    accountId,
    authType: normalizedAuthType,
    model,
    upstreamMode,
    upstreamPath,
    status,
    latencyMs,
    serviceTier,
    serviceTierSource: normalizedServiceTierSource,
    promptTokens: sanitizeOptionalCount(asNumber(raw.promptTokens)),
    completionTokens: sanitizeOptionalCount(asNumber(raw.completionTokens)),
    totalTokens: sanitizeOptionalCount(asNumber(raw.totalTokens)),
    cachedPromptTokens: sanitizeOptionalCount(asNumber(raw.cachedPromptTokens)),
    imageCount: sanitizeOptionalCount(asNumber(raw.imageCount)),
    imageCostUsd: sanitizeOptionalCost(asNumber(raw.imageCostUsd)),
    promptCacheKeyUsed: raw.promptCacheKeyUsed === true,
    cacheHit: raw.cacheHit === true,
    ttftMs: sanitizeOptionalCount(asNumber(raw.ttftMs)),
    tps: asNumber(raw.tps),
    error: asString(raw.error),
    upstreamErrorCode: sanitizeOptionalShortString(raw.upstreamErrorCode, 80),
    upstreamErrorType: sanitizeOptionalShortString(raw.upstreamErrorType, 80),
    upstreamErrorMessage: sanitizeOptionalShortString(raw.upstreamErrorMessage),
    factoryDiagnostics: hydrateFactoryDiagnostics(raw.factoryDiagnostics),
    costUsd: sanitizeOptionalCost(asNumber(raw.costUsd)),
    energyJoules: sanitizeOptionalCost(asNumber(raw.energyJoules)),
    waterEvaporatedMl: sanitizeOptionalCost(asNumber(raw.waterEvaporatedMl)),
  };
}

function hydrateHourlyBucket(raw: unknown): RequestLogHourlyBucket | null {
  if (!isRecord(raw)) {
    return null;
  }

  const startMs = asNumber(raw.startMs);
  if (startMs === undefined) {
    return null;
  }

  return {
    startMs,
    requestCount: asNumber(raw.requestCount) ?? 0,
    errorCount: asNumber(raw.errorCount) ?? 0,
    totalTokens: asNumber(raw.totalTokens) ?? 0,
    promptTokens: asNumber(raw.promptTokens) ?? 0,
    completionTokens: asNumber(raw.completionTokens) ?? 0,
    cachedPromptTokens: asNumber(raw.cachedPromptTokens) ?? 0,
    imageCount: asNumber(raw.imageCount) ?? 0,
    imageCostUsd: asNumber(raw.imageCostUsd) ?? 0,
    cacheHitCount: asNumber(raw.cacheHitCount) ?? 0,
    cacheKeyUseCount: asNumber(raw.cacheKeyUseCount) ?? 0,
    fastModeRequestCount: asNumber(raw.fastModeRequestCount) ?? 0,
    priorityRequestCount: asNumber(raw.priorityRequestCount) ?? 0,
    standardRequestCount: asNumber(raw.standardRequestCount) ?? 0,
    costUsd: asNumber(raw.costUsd) ?? 0,
    energyJoules: asNumber(raw.energyJoules) ?? 0,
    waterEvaporatedMl: asNumber(raw.waterEvaporatedMl) ?? 0,
  };
}

function hydrateDailyBucket(raw: unknown): RequestLogDailyBucket | null {
  if (!isRecord(raw)) {
    return null;
  }

  const startMs = asNumber(raw.startMs);
  if (startMs === undefined) {
    return null;
  }

  return {
    startMs,
    requestCount: asNumber(raw.requestCount) ?? 0,
    errorCount: asNumber(raw.errorCount) ?? 0,
    totalTokens: asNumber(raw.totalTokens) ?? 0,
    promptTokens: asNumber(raw.promptTokens) ?? 0,
    completionTokens: asNumber(raw.completionTokens) ?? 0,
    cachedPromptTokens: asNumber(raw.cachedPromptTokens) ?? 0,
    imageCount: asNumber(raw.imageCount) ?? 0,
    imageCostUsd: asNumber(raw.imageCostUsd) ?? 0,
    cacheHitCount: asNumber(raw.cacheHitCount) ?? 0,
    cacheKeyUseCount: asNumber(raw.cacheKeyUseCount) ?? 0,
    fastModeRequestCount: asNumber(raw.fastModeRequestCount) ?? 0,
    priorityRequestCount: asNumber(raw.priorityRequestCount) ?? 0,
    standardRequestCount: asNumber(raw.standardRequestCount) ?? 0,
    costUsd: asNumber(raw.costUsd) ?? 0,
    energyJoules: asNumber(raw.energyJoules) ?? 0,
    waterEvaporatedMl: asNumber(raw.waterEvaporatedMl) ?? 0,
  };
}

function hydrateDailyModelBucket(raw: unknown): RequestLogDailyModelBucket | null {
  if (!isRecord(raw)) {
    return null;
  }

  const startMs = asNumber(raw.startMs);
  const providerId = asString(raw.providerId)?.trim();
  const model = asString(raw.model)?.trim();

  if (startMs === undefined || !providerId || !model) {
    return null;
  }

  return {
    startMs,
    providerId,
    model,
    requestCount: asNumber(raw.requestCount) ?? 0,
    errorCount: asNumber(raw.errorCount) ?? 0,
    totalTokens: asNumber(raw.totalTokens) ?? 0,
    promptTokens: asNumber(raw.promptTokens) ?? 0,
    completionTokens: asNumber(raw.completionTokens) ?? 0,
    cachedPromptTokens: asNumber(raw.cachedPromptTokens) ?? 0,
    imageCount: asNumber(raw.imageCount) ?? 0,
    imageCostUsd: asNumber(raw.imageCostUsd) ?? 0,
    cacheHitCount: asNumber(raw.cacheHitCount) ?? 0,
    cacheKeyUseCount: asNumber(raw.cacheKeyUseCount) ?? 0,
    fastModeRequestCount: asNumber(raw.fastModeRequestCount) ?? 0,
    priorityRequestCount: asNumber(raw.priorityRequestCount) ?? 0,
    standardRequestCount: asNumber(raw.standardRequestCount) ?? 0,
    ttftSum: asNumber(raw.ttftSum) ?? 0,
    ttftCount: asNumber(raw.ttftCount) ?? 0,
    tpsSum: asNumber(raw.tpsSum) ?? 0,
    tpsCount: asNumber(raw.tpsCount) ?? 0,
    lastUsedAtMs: asNumber(raw.lastUsedAtMs) ?? 0,
    costUsd: asNumber(raw.costUsd) ?? 0,
    energyJoules: asNumber(raw.energyJoules) ?? 0,
    waterEvaporatedMl: asNumber(raw.waterEvaporatedMl) ?? 0,
  };
}

function hydrateDailyAccountBucket(raw: unknown): RequestLogDailyAccountBucket | null {
  if (!isRecord(raw)) {
    return null;
  }

  const startMs = asNumber(raw.startMs);
  const providerId = asString(raw.providerId)?.trim();
  const accountId = asString(raw.accountId)?.trim();
  const authType = raw.authType;

  if (startMs === undefined || !providerId || !accountId) {
    return null;
  }

  const normalizedAuthType: RequestAuthType =
    authType === "api_key" || authType === "oauth_bearer" || authType === "local" || authType === "none"
      ? authType
      : "none";

  return {
    startMs,
    providerId,
    accountId,
    authType: normalizedAuthType,
    requestCount: asNumber(raw.requestCount) ?? 0,
    errorCount: asNumber(raw.errorCount) ?? 0,
    totalTokens: asNumber(raw.totalTokens) ?? 0,
    promptTokens: asNumber(raw.promptTokens) ?? 0,
    completionTokens: asNumber(raw.completionTokens) ?? 0,
    cachedPromptTokens: asNumber(raw.cachedPromptTokens) ?? 0,
    imageCount: asNumber(raw.imageCount) ?? 0,
    imageCostUsd: asNumber(raw.imageCostUsd) ?? 0,
    cacheHitCount: asNumber(raw.cacheHitCount) ?? 0,
    cacheKeyUseCount: asNumber(raw.cacheKeyUseCount) ?? 0,
    fastModeRequestCount: asNumber(raw.fastModeRequestCount) ?? 0,
    priorityRequestCount: asNumber(raw.priorityRequestCount) ?? 0,
    standardRequestCount: asNumber(raw.standardRequestCount) ?? 0,
    ttftSum: asNumber(raw.ttftSum) ?? 0,
    ttftCount: asNumber(raw.ttftCount) ?? 0,
    tpsSum: asNumber(raw.tpsSum) ?? 0,
    tpsCount: asNumber(raw.tpsCount) ?? 0,
    lastUsedAtMs: asNumber(raw.lastUsedAtMs) ?? 0,
    costUsd: asNumber(raw.costUsd) ?? 0,
    energyJoules: asNumber(raw.energyJoules) ?? 0,
    waterEvaporatedMl: asNumber(raw.waterEvaporatedMl) ?? 0,
  };
}

function hydrateDb(raw: unknown, maxEntries: number): RequestLogDb {
  if (Array.isArray(raw)) {
    return {
      entries: raw
        .map((entry) => hydrateEntry(entry))
        .filter((entry): entry is RequestLogEntry => entry !== null)
        .slice(-maxEntries),
      hourlyBuckets: [],
      dailyBuckets: [],
      dailyModelBuckets: [],
      dailyAccountBuckets: [],
      accountAccumulators: [],
    };
  }

  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    return emptyDb();
  }

  const hourlyBuckets = Array.isArray(raw.hourlyBuckets)
    ? raw.hourlyBuckets
        .map((bucket) => hydrateHourlyBucket(bucket))
        .filter((bucket): bucket is RequestLogHourlyBucket => bucket !== null)
    : [];

  const dailyBuckets = Array.isArray(raw.dailyBuckets)
    ? raw.dailyBuckets
        .map((bucket) => hydrateDailyBucket(bucket))
        .filter((bucket): bucket is RequestLogDailyBucket => bucket !== null)
    : [];

  const dailyModelBuckets = Array.isArray(raw.dailyModelBuckets)
    ? raw.dailyModelBuckets
        .map((bucket) => hydrateDailyModelBucket(bucket))
        .filter((bucket): bucket is RequestLogDailyModelBucket => bucket !== null)
    : [];

  const dailyAccountBuckets = Array.isArray(raw.dailyAccountBuckets)
    ? raw.dailyAccountBuckets
        .map((bucket) => hydrateDailyAccountBucket(bucket))
        .filter((bucket): bucket is RequestLogDailyAccountBucket => bucket !== null)
    : [];

  const accountAccumulators = Array.isArray(raw.accountAccumulators)
    ? raw.accountAccumulators as AccountUsageAccumulator[]
    : undefined;

  return {
    entries: raw.entries
      .map((entry) => hydrateEntry(entry))
      .filter((entry): entry is RequestLogEntry => entry !== null)
      .slice(-maxEntries),
    hourlyBuckets,
    dailyBuckets,
    dailyModelBuckets,
    dailyAccountBuckets,
    accountAccumulators,
  };
}

function sanitizeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }

  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return fallback;
  }

  return normalized;
}

function hourBucketStartMs(timestampMs: number): number {
  return Math.floor(timestampMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

function dayBucketStartMs(timestampMs: number): number {
  return Math.floor(timestampMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
}

function sumCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

type MutableAccountAccumulator = {
  providerId: string;
  accountId: string;
  authType: RequestAuthType;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  imageCount: number;
  imageCostUsd: number;
  cacheHitCount: number;
  cacheKeyUseCount: number;
  ttftSum: number;
  ttftCount: number;
  tpsSum: number;
  tpsCount: number;
  lastUsedAtMs: number;
  costUsd: number;
  energyJoules: number;
  waterEvaporatedMl: number;
};

function accountAccumulatorKey(providerId: string, accountId: string): string {
  return `${providerId}\0${accountId}`;
}

function dailyModelBucketKey(startMs: number, providerId: string, model: string): string {
  return `${startMs}\0${providerId}\0${model}`;
}

function dailyAccountBucketKey(startMs: number, providerId: string, accountId: string): string {
  return `${startMs}\0${providerId}\0${accountId}`;
}

export class RequestLogStore {
  private readonly entries: RequestLogEntry[] = [];
  private readonly hourlyBuckets = new Map<number, HourlyBucket>();
  private readonly dailyBuckets = new Map<number, DailyBucket>();
  private readonly dailyModelBuckets = new Map<string, DailyModelBucket>();
  private readonly dailyAccountBuckets = new Map<string, DailyAccountBucket>();
  private readonly perfIndex = new Map<string, PerfIndexEntry>();
  private readonly accountAccumulators = new Map<string, MutableAccountAccumulator>();
  private warmupPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = 1000,
  ) {}

  public async warmup(): Promise<void> {
    if (this.warmupPromise) {
      await this.warmupPromise;
      return;
    }

    this.warmupPromise = this.loadFromDisk();
    await this.warmupPromise;
  }

  public record(input: RequestLogRecordInput): RequestLogEntry {
    if (this.closed) {
      throw new Error("request log store is closed");
    }

    const entry: RequestLogEntry = {
      id: crypto.randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      providerId: input.providerId,
      accountId: input.accountId,
      authType: input.authType,
      model: input.model,
      upstreamMode: input.upstreamMode,
      upstreamPath: input.upstreamPath,
      status: input.status,
      latencyMs: input.latencyMs,
      serviceTier: input.serviceTier?.trim() || undefined,
      serviceTierSource: input.serviceTierSource ?? (input.serviceTier ? "explicit" : "none"),
      promptTokens: sanitizeOptionalCount(input.promptTokens),
      completionTokens: sanitizeOptionalCount(input.completionTokens),
      totalTokens: sanitizeOptionalCount(input.totalTokens),
      cachedPromptTokens: sanitizeOptionalCount(input.cachedPromptTokens),
      imageCount: sanitizeOptionalCount(input.imageCount),
      imageCostUsd: sanitizeOptionalCost(input.imageCostUsd),
      promptCacheKeyUsed: input.promptCacheKeyUsed === true,
    cacheHit: input.cacheHit === true,
    ttftMs: sanitizeOptionalCount(input.ttftMs),
    tps: input.tps,
    error: input.error,
    upstreamErrorCode: sanitizeOptionalShortString(input.upstreamErrorCode, 80),
    upstreamErrorType: sanitizeOptionalShortString(input.upstreamErrorType, 80),
    upstreamErrorMessage: sanitizeOptionalShortString(input.upstreamErrorMessage),
    factoryDiagnostics: hydrateFactoryDiagnostics(input.factoryDiagnostics),
    costUsd: sanitizeOptionalCost(input.costUsd),
    energyJoules: sanitizeOptionalCost(input.energyJoules),
    waterEvaporatedMl: sanitizeOptionalCost(input.waterEvaporatedMl),
  };

    this.entries.push(entry);
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }

    this.applyEntryToHourlyBuckets(entry);
    this.applyEntryToDailyBuckets(entry);
    this.applyEntryToDailyModelBuckets(entry);
    this.applyEntryToDailyAccountBuckets(entry);
    this.applyEntryToAccountAccumulator(entry);
    this.updatePerfIndexFromEntry(entry);
    this.schedulePersist();

    return entry;
  }

  public update(
    entryId: string,
    patch: {
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
      readonly cachedPromptTokens?: number;
      readonly imageCount?: number;
      readonly imageCostUsd?: number;
      readonly promptCacheKeyUsed?: boolean;
      readonly cacheHit?: boolean;
      readonly ttftMs?: number;
      readonly tps?: number;
      readonly error?: string;
      readonly upstreamErrorCode?: string;
      readonly upstreamErrorType?: string;
      readonly upstreamErrorMessage?: string;
      readonly factoryDiagnostics?: Factory4xxDiagnostics;
      readonly costUsd?: number;
      readonly energyJoules?: number;
      readonly waterEvaporatedMl?: number;
    },
  ): RequestLogEntry | undefined {
    if (this.closed) {
      return undefined;
    }

    const entryIndex = this.entries.findIndex((entry) => entry.id === entryId);
    if (entryIndex < 0) {
      return undefined;
    }

    const current = this.entries[entryIndex];
    if (!current) {
      return undefined;
    }

    const next: RequestLogEntry = {
      ...current,
      promptTokens: sanitizeOptionalCount(patch.promptTokens) ?? current.promptTokens,
      completionTokens: sanitizeOptionalCount(patch.completionTokens) ?? current.completionTokens,
      totalTokens: sanitizeOptionalCount(patch.totalTokens) ?? current.totalTokens,
      cachedPromptTokens: sanitizeOptionalCount(patch.cachedPromptTokens) ?? current.cachedPromptTokens,
      imageCount: sanitizeOptionalCount(patch.imageCount) ?? current.imageCount,
      imageCostUsd: sanitizeOptionalCost(patch.imageCostUsd) ?? current.imageCostUsd,
      promptCacheKeyUsed: patch.promptCacheKeyUsed ?? current.promptCacheKeyUsed,
      cacheHit: patch.cacheHit ?? current.cacheHit,
      ttftMs: sanitizeOptionalCount(patch.ttftMs) ?? current.ttftMs,
      tps: typeof patch.tps === "number" && Number.isFinite(patch.tps) ? patch.tps : current.tps,
      error: patch.error ?? current.error,
      upstreamErrorCode: sanitizeOptionalShortString(patch.upstreamErrorCode, 80) ?? current.upstreamErrorCode,
      upstreamErrorType: sanitizeOptionalShortString(patch.upstreamErrorType, 80) ?? current.upstreamErrorType,
      upstreamErrorMessage: sanitizeOptionalShortString(patch.upstreamErrorMessage) ?? current.upstreamErrorMessage,
      factoryDiagnostics: hydrateFactoryDiagnostics(patch.factoryDiagnostics) ?? current.factoryDiagnostics,
      costUsd: sanitizeOptionalCost(patch.costUsd) ?? current.costUsd,
      energyJoules: sanitizeOptionalCost(patch.energyJoules) ?? current.energyJoules,
      waterEvaporatedMl: sanitizeOptionalCost(patch.waterEvaporatedMl) ?? current.waterEvaporatedMl,
    };

    this.entries.splice(entryIndex, 1, next);
    this.applyEntryDeltaToHourlyBuckets(next, current);
    this.applyEntryDeltaToDailyBuckets(next, current);
    this.applyEntryDeltaToDailyModelBuckets(next, current);
    this.applyEntryDeltaToDailyAccountBuckets(next, current);
    this.applyEntryDeltaToAccountAccumulator(next, current);
    this.updatePerfIndexFromEntry(next);
    this.schedulePersist();
    return next;
  }

  public snapshot(): RequestLogEntry[] {
    return [...this.entries];
  }

  public snapshotHourlyBuckets(sinceMs?: number): RequestLogHourlyBucket[] {
    const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;

    return [...this.hourlyBuckets.values()]
      .filter((bucket) => bucket.startMs >= since)
      .sort((a, b) => a.startMs - b.startMs)
      .map((bucket) => ({
        startMs: bucket.startMs,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalTokens: bucket.totalTokens,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedPromptTokens: bucket.cachedPromptTokens,
        imageCount: bucket.imageCount,
        imageCostUsd: bucket.imageCostUsd,
        cacheHitCount: bucket.cacheHitCount,
        cacheKeyUseCount: bucket.cacheKeyUseCount,
        fastModeRequestCount: bucket.fastModeRequestCount,
        priorityRequestCount: bucket.priorityRequestCount,
        standardRequestCount: bucket.standardRequestCount,
        costUsd: bucket.costUsd,
        energyJoules: bucket.energyJoules,
        waterEvaporatedMl: bucket.waterEvaporatedMl,
      }));
  }

  public snapshotDailyBuckets(sinceMs?: number): RequestLogDailyBucket[] {
    const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;

    return [...this.dailyBuckets.values()]
      .filter((bucket) => bucket.startMs >= since)
      .sort((a, b) => a.startMs - b.startMs)
      .map((bucket) => ({
        startMs: bucket.startMs,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalTokens: bucket.totalTokens,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedPromptTokens: bucket.cachedPromptTokens,
        imageCount: bucket.imageCount,
        imageCostUsd: bucket.imageCostUsd,
        cacheHitCount: bucket.cacheHitCount,
        cacheKeyUseCount: bucket.cacheKeyUseCount,
        fastModeRequestCount: bucket.fastModeRequestCount,
        priorityRequestCount: bucket.priorityRequestCount,
        standardRequestCount: bucket.standardRequestCount,
        costUsd: bucket.costUsd,
        energyJoules: bucket.energyJoules,
        waterEvaporatedMl: bucket.waterEvaporatedMl,
      }));
  }

  public snapshotDailyModelBuckets(sinceMs?: number): RequestLogDailyModelBucket[] {
    const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;

    return [...this.dailyModelBuckets.values()]
      .filter((bucket) => bucket.startMs >= since)
      .sort((left, right) => left.startMs - right.startMs || left.providerId.localeCompare(right.providerId) || left.model.localeCompare(right.model))
      .map((bucket) => ({ ...bucket }));
  }

  public snapshotDailyAccountBuckets(sinceMs?: number): RequestLogDailyAccountBucket[] {
    const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;

    return [...this.dailyAccountBuckets.values()]
      .filter((bucket) => bucket.startMs >= since)
      .sort((left, right) => left.startMs - right.startMs || left.providerId.localeCompare(right.providerId) || left.accountId.localeCompare(right.accountId))
      .map((bucket) => ({ ...bucket }));
  }

  public getCoverage(): RequestLogCoverage {
    const earliestEntryAtMs = this.entries[0]?.timestamp ?? null;
    const earliestHourlyBucketAtMs = [...this.hourlyBuckets.keys()].reduce<number | null>((min, startMs) => min === null ? startMs : Math.min(min, startMs), null);
    const earliestDailyBucketAtMs = [...this.dailyBuckets.keys()].reduce<number | null>((min, startMs) => min === null ? startMs : Math.min(min, startMs), null);
    const earliestModelBreakdownAtMs = [...this.dailyModelBuckets.values()].reduce<number | null>((min, bucket) => min === null ? bucket.startMs : Math.min(min, bucket.startMs), null);
    const earliestAccountBreakdownAtMs = [...this.dailyAccountBuckets.values()].reduce<number | null>((min, bucket) => min === null ? bucket.startMs : Math.min(min, bucket.startMs), null);

    return {
      earliestEntryAtMs,
      earliestHourlyBucketAtMs,
      earliestDailyBucketAtMs,
      earliestModelBreakdownAtMs,
      earliestAccountBreakdownAtMs,
      retainedEntryCount: this.entries.length,
      maxEntries: this.maxEntries,
    };
  }

  public getPerfSummary(
    providerId: string,
    accountId: string,
    model: string,
    upstreamMode: string,
  ): RequestLogPerfSummary | undefined {
    const key = `${providerId}\0${accountId}\0${model}\0${upstreamMode}`;
    const entry = this.perfIndex.get(key);
    return entry ? { ...entry } : undefined;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.persistChain.catch(() => undefined);
  }

  public list(filters: RequestLogFilters = {}): RequestLogEntry[] {
    const limit = sanitizeLimit(filters.limit, 200);

    let source = this.entries;
    if (filters.before) {
      const cursorIdx = this.entries.findIndex((e) => e.id === filters.before);
      if (cursorIdx > 0) {
        source = this.entries.slice(0, cursorIdx);
      } else if (cursorIdx === 0) {
        return [];
      }
    }

    const filtered = source.filter((entry) => {
      if (filters.providerId && entry.providerId !== filters.providerId) {
        return false;
      }

      if (filters.accountId && entry.accountId !== filters.accountId) {
        return false;
      }

      return true;
    });

    return filtered.slice(-limit).reverse();
  }

  public providerSummary(): Record<string, { readonly count: number; readonly lastTimestamp: number }> {
    const summary: Record<string, { count: number; lastTimestamp: number }> = {};

    for (const entry of this.entries) {
      const existing = summary[entry.providerId];
      if (!existing) {
        summary[entry.providerId] = {
          count: 1,
          lastTimestamp: entry.timestamp,
        };
        continue;
      }

      existing.count += 1;
      existing.lastTimestamp = Math.max(existing.lastTimestamp, entry.timestamp);
    }

    return summary;
  }

  private getOrCreateHourlyBucket(startMs: number): HourlyBucket {
    const existing = this.hourlyBuckets.get(startMs);
    if (existing) {
      return existing;
    }

    const created: HourlyBucket = {
      startMs,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      fastModeRequestCount: 0,
      priorityRequestCount: 0,
      standardRequestCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
    };

    this.hourlyBuckets.set(startMs, created);
    return created;
  }

  private getOrCreateDailyBucket(startMs: number): DailyBucket {
    const existing = this.dailyBuckets.get(startMs);
    if (existing) {
      return existing;
    }

    const created: DailyBucket = {
      startMs,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      fastModeRequestCount: 0,
      priorityRequestCount: 0,
      standardRequestCount: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
    };

    this.dailyBuckets.set(startMs, created);
    return created;
  }

  private getOrCreateDailyModelBucket(startMs: number, providerId: string, model: string): DailyModelBucket {
    const key = dailyModelBucketKey(startMs, providerId, model);
    const existing = this.dailyModelBuckets.get(key);
    if (existing) {
      return existing;
    }

    const created: DailyModelBucket = {
      startMs,
      providerId,
      model,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      fastModeRequestCount: 0,
      priorityRequestCount: 0,
      standardRequestCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      lastUsedAtMs: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
    };

    this.dailyModelBuckets.set(key, created);
    return created;
  }

  private getOrCreateDailyAccountBucket(startMs: number, providerId: string, accountId: string, authType: RequestAuthType): DailyAccountBucket {
    const key = dailyAccountBucketKey(startMs, providerId, accountId);
    const existing = this.dailyAccountBuckets.get(key);
    if (existing) {
      return existing;
    }

    const created: DailyAccountBucket = {
      startMs,
      providerId,
      accountId,
      authType,
      requestCount: 0,
      errorCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 0,
      imageCount: 0,
      imageCostUsd: 0,
      cacheHitCount: 0,
      cacheKeyUseCount: 0,
      fastModeRequestCount: 0,
      priorityRequestCount: 0,
      standardRequestCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      tpsSum: 0,
      tpsCount: 0,
      lastUsedAtMs: 0,
      costUsd: 0,
      energyJoules: 0,
      waterEvaporatedMl: 0,
    };

    this.dailyAccountBuckets.set(key, created);
    return created;
  }

  private pruneHourlyBuckets(now: number = Date.now()): void {
    // Keep ~8 days of buckets (safety margin).
    const cutoff = hourBucketStartMs(now - 8 * 24 * 60 * 60 * 1000);
    for (const startMs of this.hourlyBuckets.keys()) {
      if (startMs < cutoff) {
        this.hourlyBuckets.delete(startMs);
      }
    }
  }

  private pruneDailyBuckets(now: number = Date.now()): void {
    // Keep ~45 days of buckets (safety margin for monthly + some).
    const cutoff = dayBucketStartMs(now - 45 * 24 * 60 * 60 * 1000);
    for (const startMs of this.dailyBuckets.keys()) {
      if (startMs < cutoff) {
        this.dailyBuckets.delete(startMs);
      }
    }
  }

  private pruneDailyModelBuckets(now: number = Date.now()): void {
    const cutoff = dayBucketStartMs(now - 45 * 24 * 60 * 60 * 1000);
    for (const [key, bucket] of this.dailyModelBuckets.entries()) {
      if (bucket.startMs < cutoff) {
        this.dailyModelBuckets.delete(key);
      }
    }
  }

  private pruneDailyAccountBuckets(now: number = Date.now()): void {
    const cutoff = dayBucketStartMs(now - 45 * 24 * 60 * 60 * 1000);
    for (const [key, bucket] of this.dailyAccountBuckets.entries()) {
      if (bucket.startMs < cutoff) {
        this.dailyAccountBuckets.delete(key);
      }
    }
  }

  private applyEntryToAccountAccumulator(entry: RequestLogEntry): void {
    const key = accountAccumulatorKey(entry.providerId, entry.accountId);
    const acc = this.accountAccumulators.get(key) ?? {
      providerId: entry.providerId,
      accountId: entry.accountId,
      authType: entry.authType,
      requestCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0,
      cachedPromptTokens: 0, imageCount: 0, imageCostUsd: 0, cacheHitCount: 0, cacheKeyUseCount: 0,
      ttftSum: 0, ttftCount: 0, tpsSum: 0, tpsCount: 0, lastUsedAtMs: 0,
      costUsd: 0, energyJoules: 0, waterEvaporatedMl: 0,
    };
    acc.requestCount += 1;
    acc.totalTokens += sanitizeOptionalCount(entry.totalTokens) ?? 0;
    acc.promptTokens += sanitizeOptionalCount(entry.promptTokens) ?? 0;
    acc.completionTokens += sanitizeOptionalCount(entry.completionTokens) ?? 0;
    acc.cachedPromptTokens += sanitizeOptionalCount(entry.cachedPromptTokens) ?? 0;
    acc.imageCount += sanitizeOptionalCount(entry.imageCount) ?? 0;
    acc.imageCostUsd += sanitizeOptionalCost(entry.imageCostUsd) ?? 0;
    acc.costUsd += sanitizeOptionalCost(entry.costUsd) ?? 0;
    acc.energyJoules += sanitizeOptionalCost(entry.energyJoules) ?? 0;
    acc.waterEvaporatedMl += sanitizeOptionalCost(entry.waterEvaporatedMl) ?? 0;
    if (entry.cacheHit) acc.cacheHitCount += 1;
    if (entry.promptCacheKeyUsed) acc.cacheKeyUseCount += 1;
    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) { acc.ttftSum += entry.ttftMs; acc.ttftCount += 1; }
    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) { acc.tpsSum += entry.tps; acc.tpsCount += 1; }
    acc.lastUsedAtMs = Math.max(acc.lastUsedAtMs, entry.timestamp);
    this.accountAccumulators.set(key, acc);
  }

  private applyEntryDeltaToAccountAccumulator(next: RequestLogEntry, prev: RequestLogEntry): void {
    const key = accountAccumulatorKey(next.providerId, next.accountId);
    const acc = this.accountAccumulators.get(key);
    if (!acc) return;
    acc.totalTokens += (sanitizeOptionalCount(next.totalTokens) ?? 0) - (sanitizeOptionalCount(prev.totalTokens) ?? 0);
    acc.promptTokens += (sanitizeOptionalCount(next.promptTokens) ?? 0) - (sanitizeOptionalCount(prev.promptTokens) ?? 0);
    acc.completionTokens += (sanitizeOptionalCount(next.completionTokens) ?? 0) - (sanitizeOptionalCount(prev.completionTokens) ?? 0);
    acc.cachedPromptTokens += (sanitizeOptionalCount(next.cachedPromptTokens) ?? 0) - (sanitizeOptionalCount(prev.cachedPromptTokens) ?? 0);
    acc.imageCount += (sanitizeOptionalCount(next.imageCount) ?? 0) - (sanitizeOptionalCount(prev.imageCount) ?? 0);
    acc.imageCostUsd += (sanitizeOptionalCost(next.imageCostUsd) ?? 0) - (sanitizeOptionalCost(prev.imageCostUsd) ?? 0);
    acc.costUsd += (sanitizeOptionalCost(next.costUsd) ?? 0) - (sanitizeOptionalCost(prev.costUsd) ?? 0);
    acc.energyJoules += (sanitizeOptionalCost(next.energyJoules) ?? 0) - (sanitizeOptionalCost(prev.energyJoules) ?? 0);
    acc.waterEvaporatedMl += (sanitizeOptionalCost(next.waterEvaporatedMl) ?? 0) - (sanitizeOptionalCost(prev.waterEvaporatedMl) ?? 0);
    if (next.cacheHit && !prev.cacheHit) acc.cacheHitCount += 1;
    if (next.promptCacheKeyUsed && !prev.promptCacheKeyUsed) acc.cacheKeyUseCount += 1;
    if (typeof next.ttftMs === "number" && Number.isFinite(next.ttftMs) && (prev.ttftMs === undefined || prev.ttftMs === null)) {
      acc.ttftSum += next.ttftMs; acc.ttftCount += 1;
    }
    if (typeof next.tps === "number" && Number.isFinite(next.tps) && (prev.tps === undefined || prev.tps === null)) {
      acc.tpsSum += next.tps; acc.tpsCount += 1;
    }
  }

  public snapshotAccountAccumulators(): readonly AccountUsageAccumulator[] {
    return [...this.accountAccumulators.values()];
  }

  private applyEntryToHourlyBuckets(entry: RequestLogEntry): void {
    const bucketStart = hourBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateHourlyBucket(bucketStart);

    bucket.requestCount += 1;

    const isError = entry.status >= 400 || typeof entry.error === "string";
    if (isError) {
      bucket.errorCount += 1;
    }

    if (entry.serviceTierSource === "fast_mode") {
      bucket.fastModeRequestCount += 1;
    } else if (entry.serviceTier === "priority") {
      bucket.priorityRequestCount += 1;
    } else {
      bucket.standardRequestCount += 1;
    }

    bucket.totalTokens += sumCount(entry.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneHourlyBuckets(entry.timestamp);
  }

  private applyEntryToDailyBuckets(entry: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyBucket(bucketStart);

    bucket.requestCount += 1;

    const isError = entry.status >= 400 || typeof entry.error === "string";
    if (isError) {
      bucket.errorCount += 1;
    }

    if (entry.serviceTierSource === "fast_mode") {
      bucket.fastModeRequestCount += 1;
    } else if (entry.serviceTier === "priority") {
      bucket.priorityRequestCount += 1;
    } else {
      bucket.standardRequestCount += 1;
    }

    bucket.totalTokens += sumCount(entry.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneDailyBuckets(entry.timestamp);
  }

  private applyEntryToDailyModelBuckets(entry: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyModelBucket(bucketStart, entry.providerId, entry.model);

    bucket.requestCount += 1;

    const isError = entry.status >= 400 || typeof entry.error === "string";
    if (isError) {
      bucket.errorCount += 1;
    }

    if (entry.serviceTierSource === "fast_mode") {
      bucket.fastModeRequestCount += 1;
    } else if (entry.serviceTier === "priority") {
      bucket.priorityRequestCount += 1;
    } else {
      bucket.standardRequestCount += 1;
    }

    bucket.totalTokens += sumCount(entry.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
      bucket.ttftSum += entry.ttftMs;
      bucket.ttftCount += 1;
    }

    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
      bucket.tpsSum += entry.tps;
      bucket.tpsCount += 1;
    }

    bucket.lastUsedAtMs = Math.max(bucket.lastUsedAtMs, entry.timestamp);

    this.pruneDailyModelBuckets(entry.timestamp);
  }

  private applyEntryToDailyAccountBuckets(entry: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyAccountBucket(bucketStart, entry.providerId, entry.accountId, entry.authType);

    bucket.requestCount += 1;

    const isError = entry.status >= 400 || typeof entry.error === "string";
    if (isError) {
      bucket.errorCount += 1;
    }

    if (entry.serviceTierSource === "fast_mode") {
      bucket.fastModeRequestCount += 1;
    } else if (entry.serviceTier === "priority") {
      bucket.priorityRequestCount += 1;
    } else {
      bucket.standardRequestCount += 1;
    }

    bucket.totalTokens += sumCount(entry.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)) {
      bucket.ttftSum += entry.ttftMs;
      bucket.ttftCount += 1;
    }

    if (typeof entry.tps === "number" && Number.isFinite(entry.tps)) {
      bucket.tpsSum += entry.tps;
      bucket.tpsCount += 1;
    }

    bucket.lastUsedAtMs = Math.max(bucket.lastUsedAtMs, entry.timestamp);
    this.pruneDailyAccountBuckets(entry.timestamp);
  }

  private applyEntryDeltaToHourlyBuckets(entry: RequestLogEntry, previous: RequestLogEntry): void {
    const bucketStart = hourBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateHourlyBucket(bucketStart);

    bucket.totalTokens += sumCount(entry.totalTokens) - sumCount(previous.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens) - sumCount(previous.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens) - sumCount(previous.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens) - sumCount(previous.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount) - sumCount(previous.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd) - sumCount(previous.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd) - sumCount(previous.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules) - sumCount(previous.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl) - sumCount(previous.waterEvaporatedMl);

    // promptCacheKeyUsed / cacheHit are only ever expected to flip false->true.
    if (entry.promptCacheKeyUsed && !previous.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit && !previous.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneHourlyBuckets(entry.timestamp);
  }

  private applyEntryDeltaToDailyBuckets(entry: RequestLogEntry, previous: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyBucket(bucketStart);

    bucket.totalTokens += sumCount(entry.totalTokens) - sumCount(previous.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens) - sumCount(previous.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens) - sumCount(previous.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens) - sumCount(previous.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount) - sumCount(previous.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd) - sumCount(previous.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd) - sumCount(previous.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules) - sumCount(previous.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl) - sumCount(previous.waterEvaporatedMl);

    // promptCacheKeyUsed / cacheHit are only ever expected to flip false->true.
    if (entry.promptCacheKeyUsed && !previous.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit && !previous.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    this.pruneDailyBuckets(entry.timestamp);
  }

  private applyEntryDeltaToDailyModelBuckets(entry: RequestLogEntry, previous: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyModelBucket(bucketStart, entry.providerId, entry.model);

    bucket.totalTokens += sumCount(entry.totalTokens) - sumCount(previous.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens) - sumCount(previous.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens) - sumCount(previous.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens) - sumCount(previous.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount) - sumCount(previous.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd) - sumCount(previous.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd) - sumCount(previous.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules) - sumCount(previous.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl) - sumCount(previous.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed && !previous.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit && !previous.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs) && (previous.ttftMs === undefined || previous.ttftMs === null)) {
      bucket.ttftSum += entry.ttftMs;
      bucket.ttftCount += 1;
    }

    if (typeof entry.tps === "number" && Number.isFinite(entry.tps) && (previous.tps === undefined || previous.tps === null)) {
      bucket.tpsSum += entry.tps;
      bucket.tpsCount += 1;
    }

    bucket.lastUsedAtMs = Math.max(bucket.lastUsedAtMs, entry.timestamp);

    this.pruneDailyModelBuckets(entry.timestamp);
  }

  private applyEntryDeltaToDailyAccountBuckets(entry: RequestLogEntry, previous: RequestLogEntry): void {
    const bucketStart = dayBucketStartMs(entry.timestamp);
    const bucket = this.getOrCreateDailyAccountBucket(bucketStart, entry.providerId, entry.accountId, entry.authType);

    bucket.totalTokens += sumCount(entry.totalTokens) - sumCount(previous.totalTokens);
    bucket.promptTokens += sumCount(entry.promptTokens) - sumCount(previous.promptTokens);
    bucket.completionTokens += sumCount(entry.completionTokens) - sumCount(previous.completionTokens);
    bucket.cachedPromptTokens += sumCount(entry.cachedPromptTokens) - sumCount(previous.cachedPromptTokens);
    bucket.imageCount += sumCount(entry.imageCount) - sumCount(previous.imageCount);
    bucket.imageCostUsd += sumCount(entry.imageCostUsd) - sumCount(previous.imageCostUsd);
    bucket.costUsd += sumCount(entry.costUsd) - sumCount(previous.costUsd);
    bucket.energyJoules += sumCount(entry.energyJoules) - sumCount(previous.energyJoules);
    bucket.waterEvaporatedMl += sumCount(entry.waterEvaporatedMl) - sumCount(previous.waterEvaporatedMl);

    if (entry.promptCacheKeyUsed && !previous.promptCacheKeyUsed) {
      bucket.cacheKeyUseCount += 1;
    }

    if (entry.cacheHit && !previous.cacheHit) {
      bucket.cacheHitCount += 1;
    }

    if (typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs) && (previous.ttftMs === undefined || previous.ttftMs === null)) {
      bucket.ttftSum += entry.ttftMs;
      bucket.ttftCount += 1;
    }

    if (typeof entry.tps === "number" && Number.isFinite(entry.tps) && (previous.tps === undefined || previous.tps === null)) {
      bucket.tpsSum += entry.tps;
      bucket.tpsCount += 1;
    }

    bucket.lastUsedAtMs = Math.max(bucket.lastUsedAtMs, entry.timestamp);
    this.pruneDailyAccountBuckets(entry.timestamp);
  }

  private updatePerfIndexFromEntry(entry: RequestLogEntry): void {
    const key = `${entry.providerId}\0${entry.accountId}\0${entry.model}\0${entry.upstreamMode}`;

    const ttftMsRaw = typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs)
      ? entry.ttftMs
      : entry.latencyMs;
    const ttftMs = Math.max(0, ttftMsRaw);

    const derivedTps =
      typeof entry.tps === "number" && Number.isFinite(entry.tps)
        ? entry.tps
        : typeof entry.completionTokens === "number" && Number.isFinite(entry.completionTokens) && entry.latencyMs > 0
          ? entry.completionTokens / (entry.latencyMs / 1000)
          : null;

    const alpha = 0.20;
    const existing = this.perfIndex.get(key);
    if (!existing) {
      this.perfIndex.set(key, {
        providerId: entry.providerId,
        accountId: entry.accountId,
        model: entry.model,
        upstreamMode: entry.upstreamMode,
        sampleCount: 1,
        ewmaTtftMs: ttftMs,
        ewmaTps: derivedTps,
        updatedAt: entry.timestamp,
      });
      return;
    }

    existing.sampleCount += 1;
    existing.ewmaTtftMs = existing.sampleCount <= 1
      ? ttftMs
      : existing.ewmaTtftMs * (1 - alpha) + ttftMs * alpha;

    if (derivedTps !== null) {
      existing.ewmaTps = existing.ewmaTps === null ? derivedTps : existing.ewmaTps * (1 - alpha) + derivedTps * alpha;
    }

    existing.updatedAt = Math.max(existing.updatedAt, entry.timestamp);
  }

  private rebuildPerfIndex(): void {
    this.perfIndex.clear();
    for (const entry of this.entries) {
      this.updatePerfIndexFromEntry(entry);
    }
  }

  private rebuildAccountAccumulators(): void {
    this.accountAccumulators.clear();
    for (const entry of this.entries) {
      this.applyEntryToAccountAccumulator(entry);
    }
  }

  private resetState(): void {
    this.entries.splice(0, this.entries.length);
    this.hourlyBuckets.clear();
    this.dailyBuckets.clear();
    this.dailyModelBuckets.clear();
    this.dailyAccountBuckets.clear();
    this.perfIndex.clear();
    this.accountAccumulators.clear();
  }

  private snapshotDb(): RequestLogDb {
    return {
      entries: this.entries,
      hourlyBuckets: this.snapshotHourlyBuckets(),
      dailyBuckets: this.snapshotDailyBuckets(),
      dailyModelBuckets: this.snapshotDailyModelBuckets(),
      dailyAccountBuckets: this.snapshotDailyAccountBuckets(),
      accountAccumulators: this.snapshotAccountAccumulators(),
    };
  }

  private rebuildHourlyBucketsFromEntries(): void {
    this.hourlyBuckets.clear();
    for (const entry of this.entries) {
      this.applyEntryToHourlyBuckets(entry);
    }
  }

  private rebuildDailyBucketsFromEntries(): void {
    this.dailyBuckets.clear();
    for (const entry of this.entries) {
      this.applyEntryToDailyBuckets(entry);
    }
  }

  private rebuildDailyModelBucketsFromEntries(): void {
    this.dailyModelBuckets.clear();
    for (const entry of this.entries) {
      this.applyEntryToDailyModelBuckets(entry);
    }
  }

  private rebuildDailyAccountBucketsFromEntries(): void {
    this.dailyAccountBuckets.clear();
    for (const entry of this.entries) {
      this.applyEntryToDailyAccountBuckets(entry);
    }
  }

  private rebuildDailyBucketsFromHourlyBuckets(): void {
    this.dailyBuckets.clear();
    for (const bucket of this.hourlyBuckets.values()) {
      const dayStart = dayBucketStartMs(bucket.startMs);
      const daily = this.getOrCreateDailyBucket(dayStart);
      daily.requestCount += bucket.requestCount;
      daily.errorCount += bucket.errorCount;
      daily.totalTokens += bucket.totalTokens;
      daily.promptTokens += bucket.promptTokens;
      daily.completionTokens += bucket.completionTokens;
      daily.cachedPromptTokens += bucket.cachedPromptTokens;
      daily.imageCount += bucket.imageCount;
      daily.imageCostUsd += bucket.imageCostUsd;
      daily.cacheHitCount += bucket.cacheHitCount;
      daily.cacheKeyUseCount += bucket.cacheKeyUseCount;
      daily.fastModeRequestCount += bucket.fastModeRequestCount;
      daily.priorityRequestCount += bucket.priorityRequestCount;
      daily.standardRequestCount += bucket.standardRequestCount;
      daily.costUsd += bucket.costUsd;
      daily.energyJoules += bucket.energyJoules;
      daily.waterEvaporatedMl += bucket.waterEvaporatedMl;
    }

    this.pruneDailyBuckets();
  }

  private async quarantineCorruptFile(error: SyntaxError): Promise<void> {
    const corruptFilePath = buildCorruptFilePath(this.filePath);

    try {
      await rename(this.filePath, corruptFilePath);
      console.warn(
        `[request-log-store] Failed to parse request logs from ${this.filePath}; moved corrupt file to ${corruptFilePath}: ${error.message}`,
      );
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw renameError;
      }

      console.warn(
        `[request-log-store] Failed to parse request logs from ${this.filePath}; file disappeared before quarantine: ${error.message}`,
      );
    }

    this.resetState();
    await this.persistNow();
  }

  private async loadFromDisk(): Promise<void> {
    let contents: string;

    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      await this.persistNow();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      await this.quarantineCorruptFile(error);
      return;
    }

    const db = hydrateDb(parsed, this.maxEntries);
    this.entries.splice(0, this.entries.length, ...db.entries);
    this.repairDerivedEstimates();

    this.hourlyBuckets.clear();
    for (const bucket of db.hourlyBuckets ?? []) {
      this.hourlyBuckets.set(bucket.startMs, {
        startMs: bucket.startMs,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalTokens: bucket.totalTokens,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedPromptTokens: bucket.cachedPromptTokens,
        imageCount: bucket.imageCount,
        imageCostUsd: bucket.imageCostUsd,
        cacheHitCount: bucket.cacheHitCount,
        cacheKeyUseCount: bucket.cacheKeyUseCount,
        fastModeRequestCount: bucket.fastModeRequestCount,
        priorityRequestCount: bucket.priorityRequestCount,
        standardRequestCount: bucket.standardRequestCount,
        costUsd: bucket.costUsd,
        energyJoules: bucket.energyJoules,
        waterEvaporatedMl: bucket.waterEvaporatedMl,
      });
    }

    if ((db.hourlyBuckets?.length ?? 0) === 0 && this.entries.length > 0) {
      this.rebuildHourlyBucketsFromEntries();
    }

    this.dailyBuckets.clear();
    for (const bucket of db.dailyBuckets ?? []) {
      this.dailyBuckets.set(bucket.startMs, {
        startMs: bucket.startMs,
        requestCount: bucket.requestCount,
        errorCount: bucket.errorCount,
        totalTokens: bucket.totalTokens,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cachedPromptTokens: bucket.cachedPromptTokens,
        imageCount: bucket.imageCount,
        imageCostUsd: bucket.imageCostUsd,
        cacheHitCount: bucket.cacheHitCount,
        cacheKeyUseCount: bucket.cacheKeyUseCount,
        fastModeRequestCount: bucket.fastModeRequestCount,
        priorityRequestCount: bucket.priorityRequestCount,
        standardRequestCount: bucket.standardRequestCount,
        costUsd: bucket.costUsd,
        energyJoules: bucket.energyJoules,
        waterEvaporatedMl: bucket.waterEvaporatedMl,
      });
    }

    if ((db.dailyBuckets?.length ?? 0) === 0) {
      if (this.hourlyBuckets.size > 0) {
        this.rebuildDailyBucketsFromHourlyBuckets();
      } else if (this.entries.length > 0) {
        this.rebuildDailyBucketsFromEntries();
      }
    }

    this.dailyModelBuckets.clear();
    for (const bucket of db.dailyModelBuckets ?? []) {
      const key = dailyModelBucketKey(bucket.startMs, bucket.providerId, bucket.model);
      this.dailyModelBuckets.set(key, { ...bucket });
    }

    if ((db.dailyModelBuckets?.length ?? 0) === 0 && this.entries.length > 0) {
      this.rebuildDailyModelBucketsFromEntries();
    }

    this.dailyAccountBuckets.clear();
    for (const bucket of db.dailyAccountBuckets ?? []) {
      const key = dailyAccountBucketKey(bucket.startMs, bucket.providerId, bucket.accountId);
      this.dailyAccountBuckets.set(key, { ...bucket });
    }

    if ((db.dailyAccountBuckets?.length ?? 0) === 0 && this.entries.length > 0) {
      this.rebuildDailyAccountBucketsFromEntries();
    }

    this.rebuildPerfIndex();

    this.accountAccumulators.clear();
    if (Array.isArray(db.accountAccumulators) && db.accountAccumulators.length > 0) {
      for (const acc of db.accountAccumulators) {
        if (isRecord(acc) && typeof acc.providerId === "string" && typeof acc.accountId === "string") {
          const key = accountAccumulatorKey(acc.providerId as string, acc.accountId as string);
          this.accountAccumulators.set(key, {
            providerId: acc.providerId as string,
            accountId: acc.accountId as string,
            authType: (acc.authType as RequestAuthType) ?? "api_key",
            requestCount: asNumber(acc.requestCount) ?? 0,
            totalTokens: asNumber(acc.totalTokens) ?? 0,
            promptTokens: asNumber(acc.promptTokens) ?? 0,
            completionTokens: asNumber(acc.completionTokens) ?? 0,
            cachedPromptTokens: asNumber(acc.cachedPromptTokens) ?? 0,
            imageCount: asNumber(acc.imageCount) ?? 0,
            imageCostUsd: asNumber(acc.imageCostUsd) ?? 0,
            cacheHitCount: asNumber(acc.cacheHitCount) ?? 0,
            cacheKeyUseCount: asNumber(acc.cacheKeyUseCount) ?? 0,
            ttftSum: asNumber(acc.ttftSum) ?? 0,
            ttftCount: asNumber(acc.ttftCount) ?? 0,
            tpsSum: asNumber(acc.tpsSum) ?? 0,
            tpsCount: asNumber(acc.tpsCount) ?? 0,
            lastUsedAtMs: asNumber(acc.lastUsedAtMs) ?? 0,
            costUsd: asNumber(acc.costUsd) ?? 0,
            energyJoules: asNumber(acc.energyJoules) ?? 0,
            waterEvaporatedMl: asNumber(acc.waterEvaporatedMl) ?? 0,
          });
        }
      }
    } else {
      this.rebuildAccountAccumulators();
    }
  }

  private repairDerivedEstimates(): void {
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry) {
        continue;
      }

      const promptTokens = sanitizeOptionalCount(entry.promptTokens) ?? 0;
      const completionTokens = sanitizeOptionalCount(entry.completionTokens) ?? 0;
      const hasTokenUsage = promptTokens > 0 || completionTokens > 0;
      const missingDerivedEstimates = sumCount(entry.costUsd) === 0
        && sumCount(entry.energyJoules) === 0
        && sumCount(entry.waterEvaporatedMl) === 0;

      if (!hasTokenUsage || !missingDerivedEstimates) {
        continue;
      }

      const repaired = estimateRequestCost(entry.model, promptTokens, completionTokens);
      this.entries[index] = {
        ...entry,
        costUsd: repaired.costUsd,
        energyJoules: repaired.energyJoules,
        waterEvaporatedMl: repaired.waterEvaporatedMl,
      };
    }
  }

  private schedulePersist(): void {
    if (this.closed) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await this.persistNow();
      });
  }

  private async persistNow(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = buildTempFilePath(this.filePath);

    try {
      await writeFile(tempFilePath, JSON.stringify(this.snapshotDb(), null, 2), "utf8");
      await rename(tempFilePath, this.filePath);
    } catch (error) {
      await rm(tempFilePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
