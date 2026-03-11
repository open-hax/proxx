import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface ProxySettings {
  readonly fastMode: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ProxySettingsStore {
  private settings: ProxySettings = {
    fastMode: false,
  };

  public constructor(private readonly filePath: string) {}

  public async warmup(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.fastMode === "boolean") {
        this.settings = {
          fastMode: parsed.fastMode,
        };
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

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
    return this.get();
  }
}
