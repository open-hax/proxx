import assert from "node:assert/strict";
import test from "node:test";

import { assertCljsRuntimeReady, loadCljsRuntime } from "../lib/cljs-runtime.js";

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
    typeof (capturedSignal as any).extendTimeout === "function",
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
    (capturedSignal as any).extendTimeout();
  });
});
