import assert from "node:assert/strict";
import test from "node:test";

import { isProxxCljsRuntime, loadCljsRuntime } from "../lib/cljs-runtime.js";
import { registerQueueAbortHandler } from "../lib/provider-strategy/shared.js";

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
