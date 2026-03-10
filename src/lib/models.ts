import { readFile } from "node:fs/promises";

interface ModelsEnvelope {
  readonly models?: readonly string[];
  readonly data?: ReadonlyArray<{ readonly id?: string }>;
}

export interface OpenAiModelResponse {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeModelIds(raw: unknown): string[] {
  const idsFromArray = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : null;

  if (idsFromArray) {
    return [...new Set(idsFromArray.map((id) => id.trim()).filter(Boolean))];
  }

  if (!isRecord(raw)) {
    throw new Error("Invalid model JSON: expected an array or {\"models\": []}");
  }

  const envelope = raw as ModelsEnvelope;
  if (Array.isArray(envelope.models)) {
    return [...new Set(envelope.models.map((id) => id.trim()).filter(Boolean))];
  }

  if (Array.isArray(envelope.data)) {
    const ids = envelope.data
      .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter(Boolean);

    return [...new Set(ids)];
  }

  throw new Error("Invalid model JSON: expected an array, {\"models\": []}, or OpenAI-style {\"data\": []}");
}

export async function loadModels(modelsFilePath: string, fallback: readonly string[]): Promise<string[]> {
  try {
    const json = await readFile(modelsFilePath, "utf8");
    const parsed: unknown = JSON.parse(json);
    const models = normalizeModelIds(parsed);
    if (models.length > 0) {
      return models;
    }
    return [...fallback];
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError?.code === "ENOENT") {
      return [...fallback];
    }

    throw error;
  }
}

export function toOpenAiModel(modelId: string): OpenAiModelResponse {
  return {
    id: modelId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "open-hax"
  };
}
