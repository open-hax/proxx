import assert from "node:assert/strict";
import test from "node:test";

import { chatRequestToOllamaRequest, streamOllamaNdjsonToChatCompletionSse } from "../lib/ollama-compat.js";

test("chatRequestToOllamaRequest normalizes gemma4 xhigh reasoning effort to max while enabling think", () => {
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
  assert.equal(payload.reasoning_effort, "max");
});

test(
  "streamOllamaNdjsonToChatCompletionSse emits incremental deltas for cumulative thinking to avoid duplicated prefixes",
  async () => {
    const encoder = new TextEncoder();
    const lines = [
      JSON.stringify({
        model: "gemma4:31b",
        created_at: "2025-01-01T00:00:00Z",
        message: { role: "assistant", content: "", thinking: "The" },
        done: false,
      }),
      JSON.stringify({
        model: "gemma4:31b",
        created_at: "2025-01-01T00:00:00Z",
        message: { role: "assistant", content: "", thinking: "The user" },
        done: false,
      }),
      JSON.stringify({
        model: "gemma4:31b",
        created_at: "2025-01-01T00:00:00Z",
        message: { role: "assistant", content: "", thinking: "The user wants" },
        done: true,
        done_reason: "stop",
      }),
    ];

    const ndjson = `${lines.join("\n")}\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ndjson));
        controller.close();
      },
    });

    const sse: string[] = [];
    await streamOllamaNdjsonToChatCompletionSse(body, "gemma4:31b", (data) => sse.push(data));

    const payloads = sse
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => chunk.slice("data: ".length).trim())
      .filter((chunk) => chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);

    const deltas = payloads
      .flatMap((evt) => (Array.isArray(evt["choices"]) ? (evt["choices"] as unknown[]) : []))
      .map((choice) => (choice && typeof choice === "object" ? (choice as Record<string, unknown>)["delta"] : undefined))
      .map((delta) => (delta && typeof delta === "object" ? (delta as Record<string, unknown>) : {}));

    const reasoningDeltas = deltas
      .map((delta) => (typeof delta["reasoning_content"] === "string" ? (delta["reasoning_content"] as string) : ""))
      .filter((text) => text.length > 0);

    assert.deepEqual(reasoningDeltas, ["The", " user", " wants"]);
  },
);
