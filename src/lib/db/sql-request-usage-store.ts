import { kernels } from "../cljs-kernels.js";
import type { Sql } from "./index.js";
import type {
  RequestLogEntry,
  RequestLogFilters,
  RequestLogMirror,
} from "../request-log-store.js";

interface RequestUsageRow {
  readonly id: string;
  readonly timestamp_ms: number | string;
  readonly tenant_id: string | null;
  readonly issuer: string | null;
  readonly key_id: string | null;
  readonly route_kind: string | null;
  readonly federation_owner_subject: string | null;
  readonly routed_peer_id: string | null;
  readonly routed_peer_label: string | null;
  readonly provider_id: string;
  readonly account_id: string;
  readonly auth_type: string;
  readonly model: string;
  readonly upstream_mode: string;
  readonly upstream_path: string;
  readonly status: number | string;
  readonly latency_ms: number | string;
  readonly service_tier: string | null;
  readonly service_tier_source: string;
  readonly prompt_tokens: number | string | null;
  readonly completion_tokens: number | string | null;
  readonly total_tokens: number | string | null;
  readonly cached_prompt_tokens: number | string | null;
  readonly image_count: number | string | null;
  readonly image_cost_usd: number | string | null;
  readonly prompt_cache_key_hash: string | null;
  readonly prompt_cache_key_used: boolean | null;
  readonly cache_hit: boolean | null;
  readonly ttft_ms: number | string | null;
  readonly tps: number | string | null;
  readonly end_to_end_tps: number | string | null;
  readonly error: string | null;
  readonly upstream_error_code: string | null;
  readonly upstream_error_type: string | null;
  readonly upstream_error_message: string | null;
  readonly factory_diagnostics: Record<string, unknown> | string | null;
  readonly cost_usd: number | string | null;
  readonly energy_joules: number | string | null;
  readonly water_evaporated_ml: number | string | null;
}

interface CursorRow {
  readonly id: string;
  readonly timestamp_ms: number | string;
}

interface CoverageRow {
  readonly earliest_entry_at_ms: number | string | null;
  readonly retained_entry_count: number | string;
}

export interface RequestUsageCoverage {
  readonly earliestEntryAtMs: number | null;
  readonly retainedEntryCount: number;
  readonly maxRetainedEntries: number;
}

type FilterWithoutPaging = Omit<RequestLogFilters, "limit" | "before">;
type SqlParams = (string | number | boolean | null)[];

// The statements, parameters and row mapping are the persisted contract in
// proxx.usage.sql; this class only executes them.
export class SqlRequestUsageStore implements RequestLogMirror {
  public constructor(private readonly sql: Sql) {}

  public async init(): Promise<void> {
    for (const statement of kernels.usageDdl()) {
      await this.sql.unsafe(statement);
    }
  }

  public async upsertEntry(entry: RequestLogEntry): Promise<void> {
    const { strings, values } = kernels.usageUpsert(entry);
    await this.sql(strings, ...(values as never[]));
  }

  public async listEntriesSince(
    sinceMs: number,
    filters: FilterWithoutPaging = {},
    limit?: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): Promise<RequestLogEntry[]> {
    const { text, values } = kernels.usageListSinceQuery(sinceMs, filters, limit, after);
    const rows = await this.sql.unsafe<RequestUsageRow[]>(text, values as SqlParams);
    return rows.map((row) => kernels.usageToEntry(row) as RequestLogEntry);
  }

  public async listEntries(filters: RequestLogFilters = {}): Promise<RequestLogEntry[]> {
    let cursor: { timestampMs: number; id: string } | undefined;

    if (typeof filters.before === "string" && filters.before.length > 0) {
      const cursorRows = await this.sql.unsafe<CursorRow[]>(kernels.usageCursorQuery(), [filters.before]);
      const cursorRow = cursorRows[0];
      if (!cursorRow) {
        return [];
      }

      cursor = kernels.usageToCursor(cursorRow);
    }

    const { text, values } = kernels.usageListQuery(filters, cursor);
    const rows = await this.sql.unsafe<RequestUsageRow[]>(text, values as SqlParams);
    return rows.map((row) => kernels.usageToEntry(row) as RequestLogEntry);
  }

  public async getCoverage(filters: FilterWithoutPaging = {}): Promise<RequestUsageCoverage> {
    const { text, values } = kernels.usageCoverageQuery(filters);
    const rows = await this.sql.unsafe<CoverageRow[]>(text, values as SqlParams);
    return kernels.usageCoverage(rows[0]);
  }
}
