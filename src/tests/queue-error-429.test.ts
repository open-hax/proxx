import { test } from "node:test";
import assert from "node:assert";
import { sendQueueError } from "../lib/provider-utils.js";

interface MockReply {
  header(name: string, value: string): MockReply;
  code(s: number): MockReply;
  send(data: unknown): void;
  getStatus(): number;
  getHeaders(): Record<string, string>;
  getSent(): unknown;
}

function mockReply(): MockReply {
  const headers: Record<string, string> = {};
  let status = 0;
  let sent: unknown = null;
  return {
    header(name: string, value: string) { headers[name] = value; return this; },
    code(s: number) { status = s; return this; },
    send(data: unknown) { sent = data; },
    getStatus() { return status; },
    getHeaders() { return headers; },
    getSent() { return sent; },
  };
}

test("sendQueueError: queue/dropped returns 429 with retry-after", () => {
  const reply = mockReply();
  const error = { data: { code: ":queue/dropped", "retry-after-ms": 5000 } };
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, error);
  assert.strictEqual(handled, true);
  assert.strictEqual(reply.getStatus(), 429);
  assert.strictEqual(reply.getHeaders()["retry-after"], "5");
});

test("sendQueueError: queue/total-timeout returns 429 with retry-after", () => {
  const reply = mockReply();
  const error = { data: { code: ":queue/total-timeout", attempt: 1, "retry-after-ms": 5000 } };
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, error);
  assert.strictEqual(handled, true);
  assert.strictEqual(reply.getStatus(), 429);
  assert.strictEqual(reply.getHeaders()["retry-after"], "5");
});

test("sendQueueError: queue/attempt-timeout returns 429 with retry-after", () => {
  const reply = mockReply();
  const error = { data: { code: ":queue/attempt-timeout", attempt: 0, "retry-after-ms": 5000 } };
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, error);
  assert.strictEqual(handled, true);
  assert.strictEqual(reply.getStatus(), 429);
  assert.strictEqual(reply.getHeaders()["retry-after"], "5");
});

test("sendQueueError: queue/exhausted returns 429 with retry-after", () => {
  const reply = mockReply();
  const error = { data: { code: ":queue/exhausted", "retry-after-ms": 10000 } };
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, error);
  assert.strictEqual(handled, true);
  assert.strictEqual(reply.getStatus(), 429);
  assert.strictEqual(reply.getHeaders()["retry-after"], "10");
});

test("sendQueueError: queue/full returns 429 with retry-after (unchanged)", () => {
  const reply = mockReply();
  const error = { data: { code: ":queue/full", "retry-after-ms": 3000 } };
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, error);
  assert.strictEqual(handled, true);
  assert.strictEqual(reply.getStatus(), 429);
  assert.strictEqual(reply.getHeaders()["retry-after"], "3");
});

test("sendQueueError: unknown error returns false", () => {
  const reply = mockReply();
  const handled = sendQueueError(reply as unknown as import("fastify").FastifyReply, new Error("something else"));
  assert.strictEqual(handled, false);
  assert.strictEqual(reply.getStatus(), 0);
});
