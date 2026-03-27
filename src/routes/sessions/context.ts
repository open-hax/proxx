import { resolve } from "node:path";

import { ChromaSessionIndex } from "../../lib/chroma-session-index.js";
import { SessionStore } from "../../lib/session-store.js";

export interface CreateSessionUiRouteContextOptions {
  readonly ollamaBaseUrl: string;
  readonly sessionsFilePath?: string;
  readonly chromaUrl?: string;
  readonly chromaCollectionName?: string;
  readonly chromaEmbeddingModel?: string;
  readonly warn?: (error: unknown) => void;
}

export interface SessionUiRouteContext {
  readonly sessionStore: SessionStore;
  readonly sessionIndex: ChromaSessionIndex;
  readonly ensureInitialSemanticIndexSync: () => Promise<void>;
}

export function createSessionUiRouteContext(
  options: CreateSessionUiRouteContextOptions,
): SessionUiRouteContext {
  const sessionStore = new SessionStore(options.sessionsFilePath ?? resolve(process.cwd(), "data/sessions.json"));
  const sessionIndex = new ChromaSessionIndex({
    url: options.chromaUrl ?? process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
    collectionName: options.chromaCollectionName ?? process.env.CHROMA_COLLECTION ?? "open_hax_proxy_sessions",
    ollamaBaseUrl: options.ollamaBaseUrl,
    embeddingModel: options.chromaEmbeddingModel ?? process.env.CHROMA_EMBED_MODEL ?? "nomic-embed-text:latest",
  });

  let initialSemanticIndexSync: Promise<void> | undefined;
  const ensureInitialSemanticIndexSync = async (): Promise<void> => {
    if (!initialSemanticIndexSync) {
      initialSemanticIndexSync = (async () => {
        try {
          const existingDocuments = await sessionStore.collectSearchDocuments();
          for (const message of existingDocuments) {
            await sessionIndex.indexMessage(message);
          }
        } catch (error) {
          options.warn?.(error);
        }
      })();
    }

    await initialSemanticIndexSync;
  };

  return {
    sessionStore,
    sessionIndex,
    ensureInitialSemanticIndexSync,
  };
}
