import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { normalizeObjectKeysWithCljs } from "./cljs-runtime.js";
import type { Sql } from "./db/index.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "./tenant-api-key.js";

export interface ProxySettings {
  readonly fastMode: boolean;
  readonly requestsPerMinute: number | null;
  readonly allowedModels: readonly string[] | null;
  readonly allowedProviderIds: readonly string[] | null;
  readonly disabledProviderIds: readonly string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CONFIG_KEY = "proxy_settings";

function normalizeProviderIdList(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  )];

  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize an input into a deduplicated, trimmed, lowercase list of model identifiers or `null` when no valid entries exist.
 *
 * @param value - The value to normalize; may be `null`, any type, or an array containing mixed entries. Only string entries are considered.
 * @returns A readonly array of normalized model IDs (trimmed, lowercased, deduplicated) if one or more valid strings are present, otherwise `null`.
 */
function normalizeModelIdList(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  )];

  return normalized.length > 0 ? normalized : null;
}

/**
 * Retrieves a property's value from an object using a camelCase key or its kebab-case alternative, preferring the camelCase entry.
 *
 * @param record - The object to read properties from.
 * @param camelKey - The camelCase property name to prefer (e.g., `requestsPerMinute`).
 * @param kebabKey - The kebab-case alternative property name to use if the camelCase value is `null` or `undefined` (e.g., `requests-per-minute`).
 * @returns The value found for `camelKey` if not `null` or `undefined`; otherwise the value for `kebabKey`, which may be `undefined`.
 */
function settingValue(record: Record<string, unknown>, camelKey: string, kebabKey: string): unknown {
  return record[camelKey] ?? record[kebabKey];
}

/**
 * Produce a validated ProxySettings object from arbitrary input.
 *
 * Parses a string input as JSON when provided; otherwise accepts objects and returns a normalized settings object.
 *
 * - `fastMode` is returned as `true` or `false` (defaults to `false`).
 * - `requestsPerMinute` is an integer >= 1 when a finite number is provided, or `null` when absent or explicitly null.
 * - `allowedModels`, `allowedProviderIds`, and `disabledProviderIds` are arrays of cleaned, deduplicated, lowercased strings or `null`.
 *
 * @returns A fully-populated `ProxySettings` object with normalized fields suitable for storage or use.
 */
function normalizeSettings(value: unknown): ProxySettings {
  if (typeof value === "string") {
    try {
      return normalizeSettings(JSON.parse(value) as unknown);
    } catch {
      return { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
    }
  }

  if (!isRecord(value)) {
    return { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
  }

  const normalizedByCljs = normalizeObjectKeysWithCljs(value);
  const settings = isRecord(normalizedByCljs) ? normalizedByCljs : value;
  const fastMode = settingValue(settings, "fastMode", "fast-mode");
  const requestsPerMinute = settingValue(settings, "requestsPerMinute", "requests-per-minute");

  const rawRequestsPerMinute = typeof requestsPerMinute === "number" && Number.isFinite(requestsPerMinute)
    ? Math.max(1, Math.floor(requestsPerMinute))
    : requestsPerMinute === null
      ? null
      : undefined;

  return {
    fastMode: typeof fastMode === "boolean" ? fastMode : false,
    requestsPerMinute: rawRequestsPerMinute ?? null,
    allowedModels: normalizeModelIdList(settingValue(settings, "allowedModels", "allowed-models")),
    allowedProviderIds: normalizeProviderIdList(settingValue(settings, "allowedProviderIds", "allowed-provider-ids")),
    disabledProviderIds: normalizeProviderIdList(settingValue(settings, "disabledProviderIds", "disabled-provider-ids")),
  };
}

function normalizeSettingsTenantId(tenantId?: string): string {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    return DEFAULT_TENANT_ID;
  }

  return normalizeTenantId(tenantId);
}

function configKeyForTenant(tenantId: string): string {
  return tenantId === DEFAULT_TENANT_ID ? CONFIG_KEY : `${CONFIG_KEY}:${tenantId}`;
}

export class ProxySettingsStore {
  private readonly settingsByTenant = new Map<string, ProxySettings>([
    [DEFAULT_TENANT_ID, { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null }],
  ]);

  public constructor(
    private readonly filePath: string,
    private readonly sql?: Sql,
  ) {}

  public async warmup(): Promise<void> {
    const defaultSettings = await this.loadDefaultSettings();
    this.settingsByTenant.set(DEFAULT_TENANT_ID, defaultSettings);
  }

  private async loadDefaultSettings(): Promise<ProxySettings> {
    if (this.sql) {
      try {
        const rows = await this.sql<Array<{ value: ProxySettings }>>`
          SELECT value FROM config WHERE key = ${configKeyForTenant(DEFAULT_TENANT_ID)}
        `;
        if (rows.length > 0) {
          return normalizeSettings(rows[0]!.value);
        }
      } catch {
        return { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
      }

      try {
        const raw = await readFile(this.filePath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        const settings = normalizeSettings(parsed);

        try {
          await this.sql`
            INSERT INTO config (key, value, updated_at)
            VALUES (${configKeyForTenant(DEFAULT_TENANT_ID)}, ${JSON.stringify(settings)}::jsonb, NOW())
            ON CONFLICT (key) DO NOTHING
          `;
        } catch {
          // ignore seed failure
        }

        return settings;
      } catch {
        return { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
      }
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeSettings(JSON.parse(raw) as unknown);
    } catch {
      return { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
    }
  }

  public get(): ProxySettings {
    return { ...(this.settingsByTenant.get(DEFAULT_TENANT_ID) ?? { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null }) };
  }

  public async getForTenant(tenantId?: string): Promise<ProxySettings> {
    const normalizedTenantId = normalizeSettingsTenantId(tenantId);
    const cached = this.settingsByTenant.get(normalizedTenantId);
    if (cached) {
      return { ...cached };
    }

    if (this.sql) {
      try {
        const rows = await this.sql<Array<{ value: ProxySettings }>>`
          SELECT value FROM config WHERE key = ${configKeyForTenant(normalizedTenantId)}
        `;
        const row = rows[0];
        if (row) {
          const loaded = normalizeSettings(row.value);
          this.settingsByTenant.set(normalizedTenantId, loaded);
          return { ...loaded };
        }
      } catch {
        // Fall back to defaults when tenant lookup fails.
      }
    }

    const fallback = this.settingsByTenant.get(DEFAULT_TENANT_ID) ?? { fastMode: false, requestsPerMinute: null, allowedModels: null, allowedProviderIds: null, disabledProviderIds: null };
    this.settingsByTenant.set(normalizedTenantId, fallback);
    return { ...fallback };
  }

  public async set(next: Partial<ProxySettings>): Promise<ProxySettings> {
    return this.setForTenant(next, DEFAULT_TENANT_ID);
  }

  public async setForTenant(next: Partial<ProxySettings>, tenantId?: string): Promise<ProxySettings> {
    const normalizedTenantId = normalizeSettingsTenantId(tenantId);
    const currentSettings = await this.getForTenant(normalizedTenantId);
    const mergedSettings: ProxySettings = {
      ...currentSettings,
      ...next,
    };
    this.settingsByTenant.set(normalizedTenantId, mergedSettings);

    if (this.sql) {
      try {
        await this.sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${configKeyForTenant(normalizedTenantId)}, ${JSON.stringify(mergedSettings)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
        `;
        return { ...mergedSettings };
      } catch {
        return { ...mergedSettings };
      }
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (normalizedTenantId === DEFAULT_TENANT_ID) {
        await writeFile(this.filePath, JSON.stringify(mergedSettings, null, 2), "utf8");
      }
    } catch {
      // Read-only filesystem; settings are still in memory
    }

    return { ...mergedSettings };
  }
}
