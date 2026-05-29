import assert from "node:assert/strict";
import test from "node:test";

import { LlamacppChatCompletionsProviderStrategy } from "../lib/provider-strategy/strategies/llamacpp.js";

test("llamacpp chat strategy preserves OpenAI input_audio content parts", () => {
  const strategy = new LlamacppChatCompletionsProviderStrategy();
  const context = {
    routeProviderId: "llamacpp",
    requestedModelInput: "gemma4:e4b",
    routingModelInput: "gemma4:e4b",
    routedModel: "gemma4:e4b",
    requestBody: {
      model: "gemma4:e4b",
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use the audio buffer and decide whether to call a tool." },
            {
              type: "input_audio",
              input_audio: {
                data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEA",
                format: "wav",
              },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "grab_latest_unseen_audio_buffers",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
    config: {},
    clientHeaders: {},
    explicitOllama: false,
    openAiPrefixed: false,
    factoryPrefixed: false,
    localOllama: false,
    clientWantsStream: true,
    needsReasoningTrace: false,
    upstreamAttemptTimeoutMs: 1000,
  };

  const payload = strategy.buildPayload(context as never).upstreamPayload;

  assert.equal(payload.model, "gemma4-e4b");
  assert.ok(Array.isArray(payload.messages));
  const firstMessage = payload.messages[0] as { readonly content?: readonly unknown[] };
  assert.deepEqual(firstMessage.content?.[1], {
    type: "input_audio",
    input_audio: {
      data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEA",
      format: "wav",
    },
  });
  assert.deepEqual(payload.tools, context.requestBody.tools);
});
