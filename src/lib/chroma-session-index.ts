import { ChromaClient, IncludeEnum } from "chromadb";

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

/**
 * Chroma session index. Sequencing, the disabled-after-first-failure latch and
 * result mapping are CLJS (`proxx.runtime.chroma`, `proxx.chroma.index`); the
 * `chromadb` classes are handed in so the runtime bundle never imports them.
 */
export class ChromaSessionIndex {
  private readonly impl: {
    readonly indexMessage: (message: ChromaIndexedMessage) => Promise<void>;
    readonly search: (query: string, limit: number) => Promise<ChromaSearchResult[]>;
  };

  public constructor(config: ChromaSessionIndexConfig) {
    registerOllamaEmbeddingFunction();
    this.impl = kernels.createChromaSessionIndex(config, {
      ChromaClient,
      IncludeEnum,
      embeddingFunction: new OllamaEmbeddingFunction({
        url: config.ollamaBaseUrl,
        model: config.embeddingModel,
      }),
    }) as unknown as typeof this.impl;
  }

  public indexMessage(message: ChromaIndexedMessage): Promise<void> {
    return this.impl.indexMessage(message);
  }

  public search(query: string, limit: number): Promise<ChromaSearchResult[]> {
    return this.impl.search(query, limit);
  }
}
