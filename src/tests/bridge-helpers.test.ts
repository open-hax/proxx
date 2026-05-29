import assert from "node:assert/strict";
import test from "node:test";

import {
  bridgeCapabilitySupportsModel,
  bridgeCapabilitySupportsPath,
} from "../lib/bridge-helpers.js";

test("bridge model capabilities are wildcard when no model list or prefixes are advertised", () => {
  assert.equal(bridgeCapabilitySupportsModel({}, "gemma4:31b"), true);
  assert.equal(bridgeCapabilitySupportsModel({ models: [], modelPrefixes: [] }, "gemma4:31b"), true);
});

test("bridge model capabilities still honor explicit model restrictions when advertised", () => {
  assert.equal(bridgeCapabilitySupportsModel({ models: ["gemma4:31b"] }, "gemma4:31b"), true);
  assert.equal(bridgeCapabilitySupportsModel({ models: ["gemma4:e4b"] }, "gemma4:31b"), false);
  assert.equal(bridgeCapabilitySupportsModel({ modelPrefixes: ["ollama/"] }, "ollama/gemma4:31b"), true);
  assert.equal(bridgeCapabilitySupportsModel({ modelPrefixes: ["ollama/"] }, "gemma4:31b"), false);
});

test("bridge path capabilities continue to require advertised route support", () => {
  assert.equal(bridgeCapabilitySupportsPath({ routes: ["/v1/chat/completions"] }, "/v1/chat/completions"), true);
  assert.equal(bridgeCapabilitySupportsPath({ routes: ["/v1/models"] }, "/v1/chat/completions"), false);
});
