import { ChromaClient, IncludeEnum, type Collection } from "chromadb";

import { kernels } from "./cljs-kernels.js";
import { OllamaEmbeddingFunction, registerOllamaEmbeddingFunction } from "./chroma-ollama-embedding.js";

import type { ChatRole } from "./session-store.js";

export interface ChromaSessionIndexConfig {
  readonly url: string;
  readonly collectionName: string;
  readonly ollamaBaseUrl: string;
  readonly embeddingModel: string;
}

export interface ChromaIndexedMessage {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt: number;
}

export interface ChromaSearchResult {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt: number;
  readonly distance: number;
}

type ChromaConnectionOptions = {
  readonly host: string;
  readonly ssl: boolean;
  readonly port?: number;
};

function parseChromaConnectionOptions(rawUrl: string): ChromaConnectionOptions {
  return kernels.chromaConnectionOptions(new URL(rawUrl));
}

export class ChromaSessionIndex {
  private readonly client: ChromaClient;
  private readonly embeddingFunction: OllamaEmbeddingFunction;
  private collectionPromise: Promise<Collection> | null = null;
  private disabled = false;

  public constructor(private readonly config: ChromaSessionIndexConfig) {
    registerOllamaEmbeddingFunction();
    this.client = new ChromaClient(parseChromaConnectionOptions(config.url));
    this.embeddingFunction = new OllamaEmbeddingFunction({
      url: this.config.ollamaBaseUrl,
      model: this.config.embeddingModel,
    });
  }

  public async indexMessage(message: ChromaIndexedMessage): Promise<void> {
    if (this.disabled || message.content.trim().length === 0) {
      return;
    }

    const collection = await this.ensureCollection();
    if (!collection) {
      return;
    }

    try {
      const embedding = await this.embedText(message.content);
      await collection.upsert({
        ids: [message.messageId],
        documents: [message.content],
        embeddings: [embedding],
        metadatas: [
          {
            sessionId: message.sessionId,
            sessionTitle: message.sessionTitle,
            messageId: message.messageId,
            role: message.role,
            createdAt: message.createdAt,
          },
        ],
      });
    } catch {
      this.disabled = true;
    }
  }

  public async search(query: string, limit: number): Promise<ChromaSearchResult[]> {
    if (this.disabled || query.trim().length === 0) {
      return [];
    }

    const collection = await this.ensureCollection();
    if (!collection) {
      return [];
    }

    try {
      const embedding = await this.embedText(query);
      const results = await collection.query({
        queryEmbeddings: [embedding],
        nResults: Math.max(1, Math.min(limit, 50)),
        include: [IncludeEnum.documents, IncludeEnum.metadatas, IncludeEnum.distances],
      });

      return kernels.chromaSearchResults(
        results.ids[0] ?? [],
        results.documents?.[0] ?? [],
        results.metadatas?.[0] ?? [],
        results.distances?.[0] ?? [],
        Date.now(),
      ) as ChromaSearchResult[];
    } catch {
      this.disabled = true;
      return [];
    }
  }

  private async ensureCollection(): Promise<Collection | null> {
    if (this.disabled) {
      return null;
    }

    if (!this.collectionPromise) {
      this.collectionPromise = this.client.getOrCreateCollection({
        name: this.config.collectionName,
        embeddingFunction: this.embeddingFunction,
        metadata: {
          source: "open-hax-openai-proxy",
        },
      });
    }

    try {
      return await this.collectionPromise;
    } catch {
      this.disabled = true;
      return null;
    }
  }

  private async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embeddingFunction.generate([text]);
    if (!embedding || embedding.length === 0) {
      throw new Error("Embedding response had empty vector");
    }

    return embedding;
  }
}
