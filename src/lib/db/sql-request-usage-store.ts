import { kernels } from "../cljs-kernels.js";
import type { Sql } from "./index.js";
import type {
  RequestLogEntry,
  RequestLogFilters,
  RequestLogMirror,
} from "../request-log-store.js";

export interface RequestUsageCoverage {
  readonly earliestEntryAtMs: number | null;
  readonly retainedEntryCount: number;
  readonly maxRetainedEntries: number;
}

type FilterWithoutPaging = Omit<RequestLogFilters, "limit" | "before">;

interface SqlRequestUsageStoreKernel {
  init(): Promise<void>;
  upsertEntry(entry: RequestLogEntry): Promise<void>;
  listEntriesSince(
    sinceMs: number,
    filters: FilterWithoutPaging,
    limit?: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): Promise<RequestLogEntry[]>;
  listEntries(filters: RequestLogFilters): Promise<RequestLogEntry[]>;
  getCoverage(filters: FilterWithoutPaging): Promise<RequestUsageCoverage>;
}

// The statements, parameters and row mapping are the persisted contract in
// proxx.usage.sql; proxx.runtime.usage-store executes them.
export class SqlRequestUsageStore implements RequestLogMirror {
  private readonly impl: SqlRequestUsageStoreKernel;

  public constructor(sql: Sql) {
    this.impl = kernels.createSqlRequestUsageStore(sql) as SqlRequestUsageStoreKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public upsertEntry(entry: RequestLogEntry): Promise<void> {
    return this.impl.upsertEntry(entry);
  }

  public listEntriesSince(
    sinceMs: number,
    filters: FilterWithoutPaging = {},
    limit?: number,
    after?: { readonly timestampMs: number; readonly id: string },
  ): Promise<RequestLogEntry[]> {
    return this.impl.listEntriesSince(sinceMs, filters, limit, after);
  }

  public listEntries(filters: RequestLogFilters = {}): Promise<RequestLogEntry[]> {
    return this.impl.listEntries(filters);
  }

  public getCoverage(filters: FilterWithoutPaging = {}): Promise<RequestUsageCoverage> {
    return this.impl.getCoverage(filters);
  }
}
