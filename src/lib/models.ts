import { kernels } from "./cljs-kernels.js";

export interface ModelPreferences {
  readonly preferred: readonly string[];
  readonly disabled: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
}

export interface OpenAiModelResponse {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

export const loadModels = (modelsFilePath: string, fallback: readonly string[]): Promise<string[]> =>
  kernels.loadModels(modelsFilePath, fallback);

export const loadDeclaredModels = (modelsFilePath: string): Promise<string[]> =>
  kernels.loadDeclaredModels(modelsFilePath);

export const loadModelPreferences = (modelsFilePath: string, fallbackPreferred: readonly string[]): Promise<ModelPreferences> =>
  kernels.loadModelPreferences(modelsFilePath, fallbackPreferred);

export const toOpenAiModel = (modelId: string): OpenAiModelResponse => kernels.toOpenAiModel(modelId);
