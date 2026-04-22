import assert from "node:assert/strict";
import test from "node:test";

import { chatRequestToOllamaRequest } from "../lib/ollama-compat.js";

test("chatRequestToOllamaRequest preserves gemma4 xhigh reasoning effort while enabling think", () => {
  const payload = chatRequestToOllamaRequest(
    {
      model: "ollama/gemma4:31b",
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      reasoning_effort: "xhigh",
      include: ["reasoning.encrypted_content"],
    },
    ["ollama/", "ollama:"],
  );

  assert.equal(payload.model, "gemma4:31b");
  assert.equal(payload.think, true);
  assert.equal(payload.reasoning_effort, "xhigh");
});