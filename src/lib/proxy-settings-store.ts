import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { Sql } from "./db/index.js";

export interface ProxySettings {
  readonly fastMode: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CONFIG_KEY = "proxy_settings";

export class ProxySettingsStore {
  private settings: ProxySettings = {
    fastMode: false,
  };

  public constructor(
    private readonly filePath: string,
    private readonly sql?: Sql,
  ) {}

  public async warmup(): Promise<void> {
    // Try DB first
    if (this.sql) {
      try {
        const rows = await this.sql<Array<{ value: ProxySettings }>>`
          SELECT value FROM config WHERE key = ${CONFIG_KEY}
        `;
        if (rows.length > 0 && isRecord(rows[0]!.value)) {
          const val = rows[0]!.value;
          this.settings = { fastMode: typeof val.fastMode === "boolean" ? val.fastMode : false };
          return;
        }
      } catch {
        // DB not ready or table missing; fall through to file
      }
    }

    // Fall back to file
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.fastMode === "boolean") {
        this.settings = { fastMode: parsed.fastMode };
      }

      // Seed DB from file if available
      if (this.sql) {
        try {
          await this.sql`
            INSERT INTO config (key, value, updated_at)
            VALUES (${CONFIG_KEY}, ${JSON.stringify(this.settings)}::jsonb, NOW())
            ON CONFLICT (key) DO NOTHING
          `;
        } catch { /* ignore seed failure */ }
      }
    } catch {
      // Start from defaults when the file is missing or invalid.
    }
  }

  public get(): ProxySettings {
    return { ...this.settings };
  }

  public async set(next: Partial<ProxySettings>): Promise<ProxySettings> {
    this.settings = {
      ...this.settings,
      ...next,
    };

    // Persist to DB if available
    if (this.sql) {
      try {
        await this.sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${CONFIG_KEY}, ${JSON.stringify(this.settings)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
        `;
        return this.get();
      } catch {
        // Fall through to file
      }
    }

    // Fall back to file
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // Read-only filesystem; settings are still in memory
    }
    return this.get();
  }
}
