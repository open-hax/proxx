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

export class OllamaEmbeddingFunction implements EmbeddingFunction {
  public readonly name = "ollama";

  public constructor(
    private readonly config: {
      readonly url: string;
      readonly model: string;
    },
  ) {}

  public async generate(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const batchEmbeddings = await this.generateBatch(texts);
    if (batchEmbeddings !== null) {
      return batchEmbeddings;
    }

    return Promise.all(texts.map(async (text) => this.generateLegacy(text)));
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

  private async generateBatch(texts: readonly string[]): Promise<number[][] | null> {
    const response = await fetch(new URL("/api/embed", `${this.config.url}/`).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Ollama /api/embed request failed: ${response.status}`);
    }

    return kernels.ollamaBatchVectors(await response.json(), texts.length);
  }

  private async generateLegacy(text: string): Promise<number[]> {
    const response = await fetch(new URL("/api/embeddings", `${this.config.url}/`).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama /api/embeddings request failed: ${response.status}`);
    }

    return kernels.ollamaLegacyVector(await response.json());
  }
}

export function registerOllamaEmbeddingFunction(): void {
  if (knownEmbeddingFunctions.has("ollama")) {
    return;
  }

  registerEmbeddingFunction("ollama", OllamaEmbeddingFunction as never);
}
