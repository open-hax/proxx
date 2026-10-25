import { randomUUID } from "node:crypto";
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

interface EventRow {
  id: string;
  ts: Date | string;
  kind: string;
  entry_id: string;
  provider_id: string | null;
  account_id: string | null;
  model: string | null;
  status: number | null;
  tags: string[] | string | null;
  meta: Record<string, unknown> | string | null;
  payload?: Record<string, unknown> | string | null;
  payload_bytes?: number | null;
}

function parseRow(row: EventRow): ProxyEvent {
  return kernels.eventParseRow(row) as ProxyEvent;
}

export class EventStore {
  private readonly buffer: EventInsert[] = [];
  private readonly labelers: EventLabeler[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  public constructor(
    private readonly sql: Sql,
    private readonly flushIntervalMs: number = 3000,
    private readonly maxBufferSize: number = 200,
  ) {}

  public async init(): Promise<void> {
    // Table and index DDL is the persisted contract in proxx.events.store/ddl.
    for (const statement of kernels.eventDdl()) {
      await this.sql.unsafe(statement);
    }

    this.startFlushTimer();
  }

  public registerLabeler(labeler: EventLabeler): void {
    this.labelers.push(labeler);
  }

  public emit(event: EventInsert): string {
    const id = randomUUID();

    const autoTags: string[] = [];
    for (const labeler of this.labelers) {
      if (labeler.applies(event)) {
        autoTags.push(...labeler.label(event));
      }
    }

    const merged: EventInsert = autoTags.length > 0
      ? { ...event, tags: [...(event.tags ?? []), ...autoTags] }
      : event;

    this.buffer.push(merged);

    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch(() => {});
    }

    return id;
  }

  public emitRequest(
    entryId: string,
    providerId: string,
    accountId: string,
    model: string,
    upstreamPayload: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void {
    this.emit({
      kind: "request",
      entryId,
      providerId,
      accountId,
      model,
      tags: [],
      meta: meta ?? {},
      payload: sanitizePayload(upstreamPayload),
    });
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
    this.emit({
      kind: "response",
      entryId,
      providerId,
      accountId,
      model,
      status,
      tags: [],
      meta: meta ?? {},
      payload: responsePayload ? sanitizePayload(responsePayload) : null,
    });
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
    this.emit({
      kind: "error",
      entryId,
      providerId,
      accountId,
      model,
      status,
      tags: [],
      meta: meta ?? {},
      payload: sanitizePayload(errorPayload),
    });
  }

  public async query(filters: EventQuery): Promise<ProxyEvent[]> {
    const { text: query, values } = kernels.eventBuildQuery(filters);

    const rows = await this.sql.unsafe<EventRow[]>(query, values as (string | number | null | Date)[]);
    return rows.map(parseRow);
  }

  public async count(filters: Omit<EventQuery, "limit" | "offset" | "orderDesc" | "includePayload">): Promise<number> {
    const { text: query, values } = kernels.eventBuildCount(filters);

    const rows = await this.sql.unsafe<Array<{ count: string }>>(query, values as Array<string | number | null>);
    const first = rows[0];
    return first ? Number.parseInt(first.count, 10) : 0;
  }

  public async getById(eventId: string): Promise<ProxyEvent | null> {
    const rows = await this.sql.unsafe<EventRow[]>(
      "SELECT * FROM events WHERE id = $1::uuid LIMIT 1",
      [eventId],
    );
    const row = rows[0];
    return row ? parseRow(row) : null;
  }

  public async addTag(eventId: string, tag: string): Promise<void> {
    const tagArray = JSON.stringify([tag]);
    await this.sql`UPDATE events SET tags = tags || ${tagArray}::jsonb WHERE id = ${eventId}::uuid AND NOT tags ? ${tag}`;
  }

  public async removeTag(eventId: string, tag: string): Promise<void> {
    await this.sql`UPDATE events SET tags = tags - ${tag} WHERE id = ${eventId}::uuid`;
  }

  public async countByTag(since?: Date): Promise<Record<string, number>> {
    const { text, values } = kernels.eventCountByTagQuery(since);
    const rows = await this.sql.unsafe<Array<{ tag: string; count: string }>>(text, values as string[]);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.tag] = parseInt(row.count, 10);
    }
    return result;
  }

  public async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    try {
      const batch = this.buffer.splice(0, this.buffer.length);
      await this.writeBatch(batch);
    } finally {
      this.flushing = false;
    }
  }

  private async writeBatch(events: EventInsert[]): Promise<void> {
    if (events.length === 0) return;

    const BATCH_SIZE = 50;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      try {
        await this.writeChunk(chunk);
      } catch (err) {
        // Log but don't throw -- don't block the proxy for event storage failures
        console.error("EventStore: failed to write batch", err);
      }
    }
  }

  private async writeChunk(events: EventInsert[]): Promise<void> {
    if (events.length === 0) return;

    for (const ev of events) {
      const payloadBytes = ev.payload ? Buffer.byteLength(JSON.stringify(ev.payload), "utf8") : null;
      // postgres.js auto-serializes JS objects/arrays to JSONB when using tagged templates.
      const tags = [...(ev.tags ?? [])] as string[];
      const meta = { ...(ev.meta ?? {}) };
      const payload = ev.payload ? { ...ev.payload } : null;

      await this.sql`
        INSERT INTO events (id, ts, kind, entry_id, provider_id, account_id, model, status, tags, meta, payload, payload_bytes)
        VALUES (
          gen_random_uuid(), NOW(),
          ${ev.kind},
          ${ev.entryId},
          ${ev.providerId ?? null},
          ${ev.accountId ?? null},
          ${ev.model ?? null},
          ${ev.status ?? null},
          ${this.sql.json(tags as never)},
          ${this.sql.json(meta as never)},
          ${payload ? this.sql.json(payload as never) : null},
          ${payloadBytes}
        )
      `;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
  }

  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return kernels.eventSanitizePayload(payload);
}
