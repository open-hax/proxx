import type postgres from "postgres";

import { kernels } from "../cljs-kernels.js";

export type Sql = postgres.Sql;

export interface DbConfig {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly idleTimeoutSeconds?: number;
  readonly connectionTimeoutSeconds?: number;
  readonly prepare?: boolean;
}

/** The Postgres client factory is CLJS (proxx.runtime.db-schema). */
export function createSqlConnection(config: DbConfig): Sql {
  return kernels.createSqlConnection(config) as Sql;
}

export async function closeConnection(sql: Sql): Promise<void> {
  await kernels.closeSqlConnection(sql);
}
