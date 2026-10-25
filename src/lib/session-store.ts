import { kernels } from "./cljs-kernels.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface SessionMessageRecord {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly reasoningContent?: string;
  readonly model?: string;
  readonly createdAt: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  promptCacheKey: string;
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  messages: SessionMessageRecord[];
}

export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly promptCacheKey: string;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
  readonly forkedFromSessionId?: string;
  readonly forkedFromMessageId?: string;
}

export interface SessionSearchDocument {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly createdAt: number;
}

/**
 * Chat sessions persisted as one JSON file. The transitions (hydrate, create,
 * append, fork, search) live in proxx.session.store; the file, cache and
 * mutation queue live in proxx.runtime.session. This class keeps the names
 * and types callers already use.
 */
export class SessionStore {
  private readonly impl: SessionStoreKernel;

  public constructor(filePath: string) {
    this.impl = kernels.createSessionStore(filePath) as SessionStoreKernel;
  }

  public listSessions(): Promise<SessionListItem[]> {
    return this.impl.listSessions();
  }

  public getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.impl.getSession(sessionId);
  }

  public createSession(title?: string): Promise<SessionRecord> {
    return this.impl.createSession(title);
  }

  public appendMessage(
    sessionId: string,
    input: {
      readonly role: ChatRole;
      readonly content: string;
      readonly reasoningContent?: string;
      readonly model?: string;
    },
  ): Promise<{ readonly session: SessionRecord; readonly message: SessionMessageRecord }> {
    return this.impl.appendMessage(sessionId, input);
  }

  public forkSession(sourceSessionId: string, sourceMessageId?: string): Promise<SessionRecord> {
    return this.impl.forkSession(sourceSessionId, sourceMessageId);
  }

  public collectSearchDocuments(): Promise<SessionSearchDocument[]> {
    return this.impl.collectSearchDocuments();
  }

  public searchLexical(query: string, limit: number): Promise<SessionSearchDocument[]> {
    return this.impl.searchLexical(query, limit);
  }
}

interface SessionStoreKernel {
  listSessions(): Promise<SessionListItem[]>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  createSession(title?: string): Promise<SessionRecord>;
  appendMessage(
    sessionId: string,
    input: {
      readonly role: ChatRole;
      readonly content: string;
      readonly reasoningContent?: string;
      readonly model?: string;
    },
  ): Promise<{ readonly session: SessionRecord; readonly message: SessionMessageRecord }>;
  forkSession(sourceSessionId: string, sourceMessageId?: string): Promise<SessionRecord>;
  collectSearchDocuments(): Promise<SessionSearchDocument[]>;
  searchLexical(query: string, limit: number): Promise<SessionSearchDocument[]>;
}
