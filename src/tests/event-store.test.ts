import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../lib/db/event-store.js";
import type { Sql } from "../lib/db/index.js";

interface UnsafeCall {
  readonly query: string;
  readonly values?: readonly unknown[];
}

class FakeSql {
  public readonly unsafeCalls: UnsafeCall[] = [];

  public async unsafe<T>(query: string, values?: readonly unknown[]): Promise<T> {
    this.unsafeCalls.push({ query, values });
    if (query.includes("SELECT COUNT(*)::text AS count FROM deleted")) {
      return [{ count: "3" }] as T;
    }
    return [] as T;
  }
}

test("EventStore init prunes rows older than configured TTL", async () => {
  const fakeSql = new FakeSql();
  const store = new EventStore(fakeSql as unknown as Sql, {
    flushIntervalMs: 0,
    ttlMs: 60_000,
    ttlSweepIntervalMs: 0,
    now: () => new Date("2026-01-01T00:01:00.000Z"),
  });

  await store.init();
  await store.close();

  const pruneCall = fakeSql.unsafeCalls.find((call) => call.query.includes("DELETE FROM events"));
  assert.ok(pruneCall, "expected init to prune expired events");
  assert.deepEqual(pruneCall.values, ["2026-01-01T00:00:00.000Z"]);
});

test("EventStore skips prune SQL when TTL is disabled", async () => {
  const fakeSql = new FakeSql();
  const store = new EventStore(fakeSql as unknown as Sql, {
    flushIntervalMs: 0,
    ttlMs: 0,
    ttlSweepIntervalMs: 0,
  });

  const deleted = await store.pruneExpired(new Date("2026-01-01T00:01:00.000Z"));

  assert.equal(deleted, 0);
  assert.equal(fakeSql.unsafeCalls.some((call) => call.query.includes("DELETE FROM events")), false);
});
