import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MigrationContext {
  readonly dataDir: string;
  readonly log: (message: string) => void;
}

export interface Migration {
  readonly id: string;
  readonly description: string;
  readonly run: (ctx: MigrationContext) => Promise<void>;
}

interface MigrationState {
  readonly applied: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function hydrateState(raw: unknown): MigrationState {
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).applied)) {
    return { applied: (raw as Record<string, unknown>).applied as string[] };
  }
  return { applied: [] };
}

export const FILE_MIGRATIONS: readonly Migration[] = [
  {
    id: "001-request-logs-json-to-jsonl",
    description: "Split monolithic request-logs.json into JSONL directory",
    async run(ctx) {
      const legacyPath = join(ctx.dataDir, "request-logs.json");
      const targetDir = join(ctx.dataDir, "request-logs");

      if (!await fileExists(legacyPath)) return;

      const contents = await readFile(legacyPath, "utf8");
      const parsed: unknown = JSON.parse(contents);

      await mkdir(targetDir, { recursive: true });

      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;

        const entries = Array.isArray(record.entries) ? record.entries : Array.isArray(parsed) ? parsed : [];
        if (entries.length > 0) {
          await writeFile(
            join(targetDir, "entries.jsonl"),
            entries.map((e: unknown) => JSON.stringify(e)).join("\n") + "\n",
            "utf8",
          );
        }

        const buckets = Array.isArray(record.hourlyBuckets) ? record.hourlyBuckets : [];
        if (buckets.length > 0) {
          await writeFile(
            join(targetDir, "hourly-buckets.jsonl"),
            buckets.map((b: unknown) => JSON.stringify(b)).join("\n") + "\n",
            "utf8",
          );
        }

        const accumulators = Array.isArray(record.accountAccumulators) ? record.accountAccumulators : [];
        if (accumulators.length > 0) {
          await writeFile(
            join(targetDir, "account-accumulators.jsonl"),
            accumulators.map((a: unknown) => JSON.stringify(a)).join("\n") + "\n",
            "utf8",
          );
        }
      }

      await rename(legacyPath, legacyPath + ".migrated");
      ctx.log("migrated request-logs.json to request-logs/ JSONL directory");
    },
  },
];

export async function runFileMigrations(ctx: MigrationContext): Promise<void> {
  await mkdir(ctx.dataDir, { recursive: true });

  const statePath = join(ctx.dataDir, ".migrations.json");

  let state: MigrationState;
  try {
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    state = hydrateState(raw);
  } catch {
    state = { applied: [] };
  }

  const applied = new Set(state.applied);
  const pending = FILE_MIGRATIONS.filter((m) => !applied.has(m.id));

  if (pending.length === 0) return;

  for (const migration of pending) {
    try {
      await migration.run(ctx);
      applied.add(migration.id);
      ctx.log(`migration ${migration.id}: done`);
    } catch (error) {
      ctx.log(`migration ${migration.id}: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await writeFile(statePath, JSON.stringify({ applied: [...applied] }, null, 2) + "\n", "utf8");
}
