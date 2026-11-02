import { kernels } from "../cljs-kernels.js";
import type { Sql } from "./index.js";

export type EventKind = "request" | "response" | "error" | "label" | "metric";

export interface ProxyEvent {
  readonly id: string;
  readonly ts: Date;
  readonly kind: EventKind;
  readonly entryId: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly model?: string;
  readonly status?: number;
  readonly tags: readonly string[];
  readonly meta: Record<string, unknown>;
  readonly payload: Record<string, unknown> | null;
  readonly payloadBytes?: number;
}

export interface EventInsert {
  readonly kind: EventKind;
  readonly entryId: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly model?: string;
  readonly status?: number;
  readonly tags?: readonly string[];
  readonly meta?: Record<string, unknown>;
  readonly payload?: Record<string, unknown> | null;
}

export interface EventQuery {
  readonly kind?: EventKind;
  readonly entryId?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly status?: number;
  readonly statusGte?: number;
  readonly statusLt?: number;
  readonly tag?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderDesc?: boolean;
  readonly includePayload?: boolean;
}

export interface EventLabeler {
  readonly id: string;
  applies(event: EventInsert): boolean;
  label(event: EventInsert): string[];
}

interface EventStoreKernel {
  init(): Promise<void>;
  registerLabeler(labeler: EventLabeler): void;
  emit(event: EventInsert): string;
  emitRequest(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    upstreamPayload: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void;
  emitResponse(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    status: number,
    responsePayload: Record<string, unknown> | null,
    meta?: Record<string, unknown>,
  ): void;
  emitError(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    status: number,
    errorPayload: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void;
  query(filters: EventQuery): Promise<ProxyEvent[]>;
  count(filters: Omit<EventQuery, "limit" | "offset" | "orderDesc" | "includePayload">): Promise<number>;
  getById(eventId: string): Promise<ProxyEvent | null>;
  addTag(eventId: string, tag: string): Promise<void>;
  removeTag(eventId: string, tag: string): Promise<void>;
  countByTag(since?: Date): Promise<Record<string, number>>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Buffered event log in Postgres. The tagging, chunking, statements and row
 * mapping are proxx.events.store; the buffer, timer and execution are
 * proxx.runtime.event-store. This class keeps the names and types callers
 * already use.
 */
export class EventStore {
  private readonly impl: EventStoreKernel;

  public constructor(sql: Sql, flushIntervalMs: number = 3000, maxBufferSize: number = 200) {
    this.impl = kernels.createEventStore(sql, flushIntervalMs, maxBufferSize) as EventStoreKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public registerLabeler(labeler: EventLabeler): void {
    this.impl.registerLabeler(labeler);
  }

  public emit(event: EventInsert): string {
    return this.impl.emit(event);
  }

  public emitRequest(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    upstreamPayload: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void {
    this.impl.emitRequest(entryId, providerId, accountId, model, upstreamPayload, meta);
  }

  public emitResponse(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    status: number,
    responsePayload: Record<string, unknown> | null,
    meta?: Record<string, unknown>,
  ): void {
    this.impl.emitResponse(entryId, providerId, accountId, model, status, responsePayload, meta);
  }

  public emitError(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    status: number,
    errorPayload: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void {
    this.impl.emitError(entryId, providerId, accountId, model, status, errorPayload, meta);
  }

  public query(filters: EventQuery): Promise<ProxyEvent[]> {
    return this.impl.query(filters);
  }

  public count(filters: Omit<EventQuery, "limit" | "offset" | "orderDesc" | "includePayload">): Promise<number> {
    return this.impl.count(filters);
  }

  public getById(eventId: string): Promise<ProxyEvent | null> {
    return this.impl.getById(eventId);
  }

  public addTag(eventId: string, tag: string): Promise<void> {
    return this.impl.addTag(eventId, tag);
  }

  public removeTag(eventId: string, tag: string): Promise<void> {
    return this.impl.removeTag(eventId, tag);
  }

  public countByTag(since?: Date): Promise<Record<string, number>> {
    return this.impl.countByTag(since);
  }

  public flush(): Promise<void> {
    return this.impl.flush();
  }

  public close(): Promise<void> {
    return this.impl.close();
  }
}
