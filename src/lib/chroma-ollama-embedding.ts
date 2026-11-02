import {
  knownEmbeddingFunctions,
  registerEmbeddingFunction,
  type EmbeddingFunction,
  type EmbeddingFunctionSpace,
} from "chromadb";

import { kernels } from "./cljs-kernels.js";

interface OllamaEmbeddingConfig {
  readonly url: string;
  readonly model_name: string;
}

/**
 * Chroma's embedding-function class protocol. The Ollama requests (batch with a
 * legacy per-text fallback) and config validation are CLJS
 * (`proxx.runtime.chroma`); this class only adapts them to `chromadb`.
 */
export class OllamaEmbeddingFunction implements EmbeddingFunction {
  public readonly name = "ollama";

  public constructor(
    private readonly config: {
      readonly url: string;
      readonly model: string;
    },
  ) {}

  public async generate(texts: string[]): Promise<number[][]> {
    return kernels.ollamaGenerate(this.config.url, this.config.model, texts);
  }

  public async generateForQueries(texts: string[]): Promise<number[][]> {
    return this.generate(texts);
  }

  public defaultSpace(): EmbeddingFunctionSpace {
    return "cosine";
  }

  public supportedSpaces(): EmbeddingFunctionSpace[] {
    return ["cosine", "l2", "ip"];
  }

  public getConfig(): OllamaEmbeddingConfig {
    return {
      url: this.config.url,
      model_name: this.config.model,
    };
  }

  public validateConfig(config: Record<string, unknown>): void {
    kernels.ollamaValidateConfig(config);
  }

  public validateConfigUpdate(_newConfig: Record<string, unknown>): void {
    // Chroma may ask whether updates are allowed. This embedding function accepts no runtime mutation.
  }

  public static buildFromConfig(config: Record<string, unknown>): OllamaEmbeddingFunction {
    const { url, model } = kernels.ollamaBuildConfig(config);

    return new OllamaEmbeddingFunction({ url, model });
  }
}

export function registerOllamaEmbeddingFunction(): void {
  if (knownEmbeddingFunctions.has("ollama")) {
    return;
  }

  registerEmbeddingFunction("ollama", OllamaEmbeddingFunction as never);
}
