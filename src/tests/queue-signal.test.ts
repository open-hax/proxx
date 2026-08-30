import assert from "node:assert/strict";
import test from "node:test";

import type { GoogleGenAI } from "@google/genai";
import type { FastifyReply } from "fastify";

import { isProxxCljsRuntime, loadCljsRuntime } from "../lib/cljs-runtime.js";
import { GeminiChatProviderStrategy } from "../lib/provider-strategy/strategies/gemini.js";
import { OpenAiResponsesPassthroughStrategy } from "../lib/provider-strategy/strategies/openai.js";
import { registerQueueAbortHandler } from "../lib/provider-strategy/shared.js";
import type { ProviderAttemptContext } from "../lib/provider-strategy/shared.js";

const requiredRuntimeShape: Record<string, unknown> = {
  normalizeKeys: (value: unknown) => value,
  validateEntity: () => ({ status: "ok" }),
  projectPheromone: () => 1,
  routePolicy: () => ({ status: "ok" }),
  loadPolicyEvidence: async () => ({}),
  loadModelPricingOverrides: () => ({}),
  previewPolicyDecision: () => ({ status: "ok" }),
  normalizeReasoningRequest: () => ({ status: "ok" }),
  resolveModelAlias: () => ({ status: "ok" }),
};

test("CLJS runtime guard validates optional classifyRateLimit", () => {
  assert.equal(isProxxCljsRuntime(requiredRuntimeShape), true);
  assert.equal(
    isProxxCljsRuntime({ ...requiredRuntimeShape, classifyRateLimit: () => ({ status: "ok" }) }),
    true,
  );
  assert.equal(
    isProxxCljsRuntime({ ...requiredRuntimeShape, classifyRateLimit: "not-a-function" }),
    false,
  );
});

test("queue abort handler ends SSE immediately and cleanup detaches it", () => {
  const writes: string[] = [];
  let ended = false;
  const rawResponse = {
    get writableEnded() {
      return ended;
    },
    write(data: string) {
      writes.push(data);
      return true;
    },
    end() {
      ended = true;
      return rawResponse;
    },
  };
  const controller = new AbortController();
  const cleanup = registerQueueAbortHandler(controller.signal, rawResponse);

  controller.abort();

  assert.equal(ended, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? "", /Provider stream aborted by request queue timeout/);
  cleanup();

  const detachedController = new AbortController();
  const detachedWrites: string[] = [];
  let detachedEnded = false;
  const detachedResponse = {
    get writableEnded() {
      return detachedEnded;
    },
    write(data: string) {
      detachedWrites.push(data);
      return true;
    },
    end() {
      detachedEnded = true;
      return detachedResponse;
    },
  };
  const detach = registerQueueAbortHandler(detachedController.signal, detachedResponse);
  detach();
  detachedController.abort();

  assert.equal(detachedEnded, false);
  assert.deepEqual(detachedWrites, []);
});

test("runQueued attaches extendTimeout to AbortController signal", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }

  if (!loaded.runtime.runQueued) {
    t.skip("runQueued not exposed by CLJS runtime");
    return;
  }

  let capturedSignal: AbortSignal | undefined;

  await loaded.runtime.runQueued(
    "resources/policies/runtime/00-manifest.edn",
    { "request-kind": "chat" },
    async (controller: AbortController) => {
      capturedSignal = controller.signal;
      // Immediately resolve so we don't wait
      return "ok";
    },
  );

  assert.ok(capturedSignal, "signal should be captured");
  assert.ok(
    typeof (capturedSignal as AbortSignal & { extendTimeout?: () => void }).extendTimeout === "function",
    "signal should have extendTimeout function",
  );
});

test("runQueued signal extendTimeout is callable", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }

  if (!loaded.runtime.runQueued) {
    t.skip("runQueued not exposed by CLJS runtime");
    return;
  }

  let capturedSignal: AbortSignal | undefined;

  await loaded.runtime.runQueued(
    "resources/policies/runtime/00-manifest.edn",
    { "request-kind": "chat" },
    async (controller: AbortController) => {
      capturedSignal = controller.signal;
      return "ok";
    },
  );

  assert.ok(capturedSignal);
  // Should not throw
  assert.doesNotThrow(() => {
    (capturedSignal as AbortSignal & { extendTimeout?: () => void }).extendTimeout?.();
  });
});

test("runQueued extendTimeout resets the attempt timer without exceeding the total deadline", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }

  if (!loaded.runtime.runQueued) {
    t.skip("runQueued not exposed by CLJS runtime");
    return;
  }

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let capturedController: AbortController | undefined;
  const pending = loaded.runtime.runQueued(
    "resources/policies/runtime/00-manifest.edn",
    { "request-kind": "chat" },
    async (controller: AbortController) => {
      capturedController = controller;
      return await new Promise<string>(() => undefined);
    },
  );

  try {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    t.mock.timers.tick(0);
    for (let index = 0; index < 5 && !capturedController; index += 1) {
      await Promise.resolve();
    }
    assert.ok(capturedController, "queue attempt should start after the zero-delay backoff");

    t.mock.timers.tick(20_000);
    const extendedSignal = capturedController.signal as AbortSignal & { extendTimeout?: () => void };
    assert.equal(typeof extendedSignal.extendTimeout, "function");
    extendedSignal.extendTimeout?.();

    t.mock.timers.tick(10_000);
    assert.equal(capturedController.signal.aborted, false, "extension should replace the original 30s timer");

    t.mock.timers.tick(89_999);
    assert.equal(capturedController.signal.aborted, false, "stream may run until the total deadline");
    t.mock.timers.tick(1);
    assert.equal(capturedController.signal.aborted, true, "extension must remain capped by the 120s total deadline");
    await assert.rejects(pending, /timed out/i);
  } finally {
    capturedController?.abort();
    await pending.catch(() => undefined);
    t.mock.timers.reset();
  }
});

test("runQueued resolves mimo provider-specific queue instance", async (t) => {
  const loaded = await loadCljsRuntime({ required: false });
  if (!loaded.loaded) {
    t.skip(`CLJS runtime artifact not built: ${loaded.reason}`);
    return;
  }

  if (!loaded.runtime.resolveQueuePolicy) {
    t.skip("resolveQueuePolicy not exposed by CLJS runtime");
    return;
  }

  const result = loaded.runtime.resolveQueuePolicy(
    "resources/policies/runtime/00-manifest.edn",
    { "provider-id": "xiaomi", "request-kind": "chat" },
  );

  assert.equal(result?.status, "ok", "should resolve queue policy");
  const policy = result?.policy as Record<string, unknown> | undefined;
  assert.equal(policy?.["attempt-timeout-ms"], 60000, "xiaomi provider should get 60s attempt timeout");
});

class MockRawStreamResponse {
  public statusCode = 0;

  public readonly headers: Record<string, unknown> = {};

  public readonly writes: unknown[] = [];

  private ended = false;

  public constructor(private readonly onFlushHeaders?: () => void) {}

  public get writableEnded(): boolean {
    return this.ended;
  }

  public setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = value;
  }

  public flushHeaders(): void {
    this.onFlushHeaders?.();
  }

  public write(data: unknown): boolean {
    if (this.ended) {
      throw new Error("ERR_STREAM_WRITE_AFTER_END");
    }
    this.writes.push(data);
    return true;
  }

  public end(): this {
    this.ended = true;
    return this;
  }
}

class MockStreamReply {
  public readonly raw: MockRawStreamResponse;

  private readonly headers: Record<string, unknown> = {};

  public constructor(onFlushHeaders?: () => void) {
    this.raw = new MockRawStreamResponse(onFlushHeaders);
  }

  public header(name: string, value: unknown): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  public removeHeader(name: string): this {
    delete this.headers[name.toLowerCase()];
    return this;
  }

  public getHeaders(): Record<string, unknown> {
    return { ...this.headers };
  }

  public code(statusCode: number): this {
    this.raw.statusCode = statusCode;
    return this;
  }

  public hijack(): this {
    return this;
  }
}

function buildAttemptContext(
  queueSignal: AbortSignal,
  overrides: Partial<ProviderAttemptContext> = {},
): ProviderAttemptContext {
  return {
    providerId: "openai",
    routeProviderId: "openai",
    baseUrl: "https://example.invalid",
    account: {
      providerId: "openai",
      accountId: "account-1",
      token: "test-token", // pragma: allowlist secret
      authType: "api_key",
    },
    hasMoreCandidates: false,
    attempt: 1,
    queueSignal,
    config: {
      streamBootstrapTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
    } as ProviderAttemptContext["config"],
    clientHeaders: {},
    requestBody: {},
    requestedModelInput: "test-model",
    routingModelInput: "test-model",
    routedModel: "test-model",
    explicitOllama: false,
    openAiPrefixed: true,
    factoryPrefixed: false,
    localOllama: false,
    clientWantsStream: true,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: 1_000,
    responsesPassthrough: true,
    imagesPassthrough: false,
    ...overrides,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`operation did not finish within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

test("OpenAI passthrough skips its first chunk when the queue signal already ended the response", async () => {
  const controller = new AbortController();
  controller.abort();

  const reply = new MockStreamReply();
  const firstChunk = new TextEncoder().encode("data: first\n\n");
  const upstreamResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(firstChunk);
        streamController.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

  const outcome = await new OpenAiResponsesPassthroughStrategy().handleProviderAttempt(
    reply as unknown as FastifyReply,
    upstreamResponse,
    buildAttemptContext(controller.signal),
  );

  assert.equal(outcome.kind, "handled");
  assert.equal(reply.raw.writableEnded, true);
  assert.equal(reply.raw.writes.length, 1);
  assert.equal(typeof reply.raw.writes[0], "string");
  assert.match(String(reply.raw.writes[0]), /Provider stream aborted by request queue timeout/);
});

test("Gemini pending stream read is cancelled by the queue signal and cleans up promptly", async () => {
  const controller = new AbortController();
  let capturedAbortSignal: AbortSignal | undefined;
  let resolveHeadersFlushed: (() => void) | undefined;
  const headersFlushed = new Promise<void>((resolve) => {
    resolveHeadersFlushed = resolve;
  });

  const fakeClient = {
    models: {
      async generateContentStream(request: { config?: Record<string, unknown> }) {
        capturedAbortSignal = request.config?.abortSignal as AbortSignal | undefined;
        const signal = capturedAbortSignal;
        assert.ok(signal, "Gemini SDK request should receive the queue abort signal");

        return (async function* pendingStream() {
          await new Promise<void>((_, reject) => {
            const rejectForAbort = () => {
              reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            };
            if (signal.aborted) {
              rejectForAbort();
              return;
            }
            signal.addEventListener("abort", rejectForAbort, { once: true });
          });
          yield {};
        })();
      },
      async generateContent() {
        throw new Error("non-streaming Gemini call was not expected");
      },
    },
  };
  const strategy = new GeminiChatProviderStrategy(
    () => fakeClient as unknown as GoogleGenAI,
  );
  const reply = new MockStreamReply(() => resolveHeadersFlushed?.());
  const outcomePromise = strategy.executeDirect(
    reply as unknown as FastifyReply,
    buildAttemptContext(controller.signal, {
      providerId: "gemini",
      routeProviderId: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      account: {
        providerId: "gemini",
        accountId: "gemini-account-1",
        token: "test-gemini-key", // pragma: allowlist secret
        authType: "api_key",
      },
      requestedModelInput: "gemini-2.5-pro",
      routingModelInput: "gemini-2.5-pro",
      routedModel: "gemini-2.5-pro",
      openAiPrefixed: false,
      responsesPassthrough: false,
    }),
    {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
  );

  await within(headersFlushed, 250);
  assert.equal(capturedAbortSignal, controller.signal);

  controller.abort();
  const outcome = await within(outcomePromise, 250);

  assert.equal(outcome.kind, "handled");
  assert.equal(reply.raw.writableEnded, true);
  assert.equal(reply.raw.writes.length, 1);
  assert.match(String(reply.raw.writes[0]), /Provider stream aborted by request queue timeout/);
});
