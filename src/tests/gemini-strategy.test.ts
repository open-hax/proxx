import assert from "node:assert";
import { describe, test } from "node:test";
import {
  GeminiChatProviderStrategy,
  geminiResponseToChatCompletion,
  openAiMessagesToGeminiContents,
  extractSystemInstructions,
  normalizeGeminiReasoningEffort,
} from "../lib/provider-strategy/strategies/gemini.js";
import { isRecord, type StrategyRequestContext } from "../lib/provider-strategy/shared.js";

function getChoices(completion: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(completion.choices) ? completion.choices as Array<Record<string, unknown>> : [];
}

function getMessage(choice: Record<string, unknown>): Record<string, unknown> {
  return isRecord(choice.message) ? choice.message : {};
}

function getUsage(completion: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(completion.usage) ? completion.usage : undefined;
}

describe("Gemini strategy request transformation", () => {
  test("converts OpenAI messages to Gemini contents", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const contents = openAiMessagesToGeminiContents(messages);
    assert.equal(contents.length, 2);
    assert.equal(contents[0]?.role, "user");
    assert.equal(contents[0]?.parts[0]?.text, "Hello");
    assert.equal(contents[1]?.role, "model");
    assert.equal(contents[1]?.parts[0]?.text, "Hi there");
  });

  test("extracts system instructions separately", () => {
    const messages = [
      { role: "system", content: "System prompt 1" },
      { role: "system", content: "System prompt 2" },
      { role: "user", content: "Hello" },
    ];

    const systemInstructions = extractSystemInstructions(messages);
    assert.equal(systemInstructions.length, 2);
    assert.equal(systemInstructions[0], "System prompt 1");
    assert.equal(systemInstructions[1], "System prompt 2");
  });

  test("handles array content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ];

    const contents = openAiMessagesToGeminiContents(messages);
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.parts[0]?.text, "Part 1Part 2");
  });

  test("skips empty messages", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "assistant", content: "Valid" },
    ];

    const contents = openAiMessagesToGeminiContents(messages);
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.parts[0]?.text, "Valid");
  });
});

describe("Gemini strategy tool request transformation", () => {
  test("transforms OpenAI tools to Gemini functionDeclarations", () => {
    const strategy = new GeminiChatProviderStrategy();
    const context = {
      routeProviderId: "gemini",
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
      } as StrategyRequestContext["config"],
      clientHeaders: {},
      requestBody: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                  unit: { type: "string", enum: ["celsius", "fahrenheit"] },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "auto",
      },
      requestAuth: undefined,
      requestedModelInput: "gemini-2.5-pro",
      routingModelInput: "gemini-2.5-pro",
      routedModel: "gemini-2.5-pro",
      explicitOllama: false,
      openAiPrefixed: false,
      factoryPrefixed: false,
      localOllama: false,
      clientWantsStream: false,
      needsReasoningTrace: false,
      upstreamAttemptTimeoutMs: 30000,
      responsesPassthrough: false,
      imagesPassthrough: false,
    };

    const payload = strategy.buildPayload(context);
    const upstreamPayload = payload.upstreamPayload;

    assert.ok(isRecord(upstreamPayload));
    assert.ok(Array.isArray(upstreamPayload.tools), "tools should be an array");
    const tools = upstreamPayload.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);

    const tool = tools[0]!;
    assert.ok(Array.isArray(tool.functionDeclarations), "functionDeclarations should be an array");
    const declarations = tool.functionDeclarations as Array<Record<string, unknown>>;
    assert.equal(declarations.length, 1);

    const declaration = declarations[0]!;
    assert.equal(declaration.name, "get_weather");
    assert.equal(declaration.description, "Get the current weather");
    assert.ok(isRecord(declaration.parameters));
    assert.equal((declaration.parameters as Record<string, unknown>).type, "object");

    assert.ok(isRecord(upstreamPayload.toolConfig));
    const functionCallingConfig = (upstreamPayload.toolConfig as Record<string, unknown>).functionCallingConfig as Record<string, unknown>;
    assert.equal(functionCallingConfig.mode, "AUTO");
  });

  test("transforms OpenAI tool_choice: none to Gemini NONE mode", () => {
    const strategy = new GeminiChatProviderStrategy();
    const context = {
      routeProviderId: "gemini",
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
      } as StrategyRequestContext["config"],
      clientHeaders: {},
      requestBody: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: "none",
      },
      requestAuth: undefined,
      requestedModelInput: "gemini-2.5-pro",
      routingModelInput: "gemini-2.5-pro",
      routedModel: "gemini-2.5-pro",
      explicitOllama: false,
      openAiPrefixed: false,
      factoryPrefixed: false,
      localOllama: false,
      clientWantsStream: false,
      needsReasoningTrace: false,
      upstreamAttemptTimeoutMs: 30000,
      responsesPassthrough: false,
      imagesPassthrough: false,
    };

    const payload = strategy.buildPayload(context);
    const upstreamPayload = payload.upstreamPayload;

    assert.ok(isRecord(upstreamPayload.toolConfig));
    const functionCallingConfig = (upstreamPayload.toolConfig as Record<string, unknown>).functionCallingConfig as Record<string, unknown>;
    assert.equal(functionCallingConfig.mode, "NONE");
  });

  test("transforms OpenAI specific tool_choice to Gemini ANY mode with allowedFunctionNames", () => {
    const strategy = new GeminiChatProviderStrategy();
    const context = {
      routeProviderId: "gemini",
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
      } as StrategyRequestContext["config"],
      clientHeaders: {},
      requestBody: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "get_weather" },
        },
      },
      requestAuth: undefined,
      requestedModelInput: "gemini-2.5-pro",
      routingModelInput: "gemini-2.5-pro",
      routedModel: "gemini-2.5-pro",
      explicitOllama: false,
      openAiPrefixed: false,
      factoryPrefixed: false,
      localOllama: false,
      clientWantsStream: false,
      needsReasoningTrace: false,
      upstreamAttemptTimeoutMs: 30000,
      responsesPassthrough: false,
      imagesPassthrough: false,
    };

    const payload = strategy.buildPayload(context);
    const upstreamPayload = payload.upstreamPayload;

    assert.ok(isRecord(upstreamPayload.toolConfig));
    const functionCallingConfig = (upstreamPayload.toolConfig as Record<string, unknown>).functionCallingConfig as Record<string, unknown>;
    assert.equal(functionCallingConfig.mode, "ANY");
    assert.ok(Array.isArray(functionCallingConfig.allowedFunctionNames));
    assert.deepEqual(functionCallingConfig.allowedFunctionNames, ["get_weather"]);
  });
});

describe("Gemini strategy response transformation", () => {
  test("transforms basic Gemini response to OpenAI chat completion", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello, how can I help?" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 7,
        totalTokenCount: 17,
      },
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    assert.ok(isRecord(completion));
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, "gemini-2.5-pro");

    const choices = getChoices(completion);
    assert.equal(choices.length, 1);
    const message = getMessage(choices[0]!);
    assert.equal(message.role, "assistant");
    assert.equal(message.content, "Hello, how can I help?");
    assert.equal(choices[0]!.finish_reason, "stop");

    const usage = getUsage(completion);
    assert.ok(usage);
    assert.equal(usage!.prompt_tokens, 10);
    assert.equal(usage!.completion_tokens, 7);
    assert.equal(usage!.total_tokens, 17);
  });

  test("handles reasoning/thinking content separately", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Let me think...", thought: true },
              { text: "The answer is 42" },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 10,
        totalTokenCount: 15,
      },
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-flash");

    assert.ok(isRecord(completion));
    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "The answer is 42");
    assert.equal(message.reasoning_content, "Let me think...");
  });

  test("handles max_tokens finish reason", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Partial response..." }],
          },
          finishReason: "MAX_TOKENS",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-3.1-pro");

    const choices = getChoices(completion);
    assert.equal(choices[0]!.finish_reason, "length");
  });

  test("handles empty response gracefully", () => {
    const completion = geminiResponseToChatCompletion({}, "gemini-2.5-pro");

    assert.ok(isRecord(completion));
    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.strictEqual(message.content, "");
    assert.equal(choices[0]!.finish_reason, "stop");
  });

  test("handles null/undefined response gracefully", () => {
    const completion = geminiResponseToChatCompletion(null, "gemini-2.5-pro");

    assert.ok(isRecord(completion));
    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "");
  });

  test("handles response without usage metadata", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "No usage data" }],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    assert.ok(isRecord(completion));
    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "No usage data");
    assert.ok(!getUsage(completion));
  });

  test("handles multiple text parts joined with newlines", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: "First paragraph" },
              { text: "Second paragraph" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "First paragraph\nSecond paragraph");
  });

  test("transforms Gemini functionCall to OpenAI tool_calls shape", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "San Francisco", unit: "celsius" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    assert.ok(isRecord(completion));
    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);

    // OpenAI expects content: null when there are tool_calls
    assert.strictEqual(message.content, null);

    // Verify tool_calls array exists and has correct shape
    assert.ok(Array.isArray(message.tool_calls), "tool_calls should be an array");
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);

    const toolCall = toolCalls[0]!;
    assert.ok(typeof toolCall.id === "string", "tool_call id should be a string");
    assert.ok(toolCall.id.startsWith("call_gemini_"), "id should have gemini prefix");
    assert.equal(toolCall.type, "function");

    const func = toolCall.function as Record<string, unknown>;
    assert.equal(func.name, "get_weather");
    assert.equal(func.arguments, '{"location":"San Francisco","unit":"celsius"}');
  });

  test("transforms multiple Gemini functionCalls to OpenAI tool_calls", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "San Francisco" },
                },
              },
              {
                functionCall: {
                  name: "get_time",
                  args: { timezone: "PST" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;

    assert.equal(toolCalls.length, 2);
    assert.equal((toolCalls[0]!.function as Record<string, unknown>).name, "get_weather");
    assert.equal((toolCalls[1]!.function as Record<string, unknown>).name, "get_time");
    assert.ok(toolCalls[0]!.id !== toolCalls[1]!.id, "Each tool call should have a unique id");
  });

  test("handles mixed text and functionCall in response", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: "I'll check that for you" },
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "San Francisco" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);

    assert.equal(message.content, "I'll check that for you");
    assert.ok(Array.isArray(message.tool_calls));
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);
  });

  test("ensures content is always a string when no tool calls", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.strictEqual(message.content, "");
    assert.ok(message.content !== null);
    assert.ok(message.content !== undefined);
  });

  test("sets content to null when there are tool calls but no text", () => {
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "SF" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemini-2.5-pro");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.strictEqual(message.content, null);
    assert.ok(Array.isArray(message.tool_calls));
  });
});

describe("Gemini reasoning effort normalization", () => {
  test("normalizes various effort levels", () => {
    assert.equal(normalizeGeminiReasoningEffort("none"), "none");
    assert.equal(normalizeGeminiReasoningEffort("disabled"), "none");
    assert.equal(normalizeGeminiReasoningEffort("off"), "none");
    assert.equal(normalizeGeminiReasoningEffort("minimal"), "minimal");
    assert.equal(normalizeGeminiReasoningEffort("low"), "low");
    assert.equal(normalizeGeminiReasoningEffort("medium"), "medium");
    assert.equal(normalizeGeminiReasoningEffort("normal"), "medium");
    assert.equal(normalizeGeminiReasoningEffort("auto"), "medium");
    assert.equal(normalizeGeminiReasoningEffort("high"), "high");
    assert.equal(normalizeGeminiReasoningEffort("xhigh"), "xhigh");
    assert.equal(normalizeGeminiReasoningEffort("max"), "xhigh");
    assert.equal(normalizeGeminiReasoningEffort("very_high"), "xhigh");
  });

  test("returns undefined for unknown values", () => {
    assert.equal(normalizeGeminiReasoningEffort("unknown"), undefined);
    assert.equal(normalizeGeminiReasoningEffort(""), undefined);
    assert.equal(normalizeGeminiReasoningEffort(null), undefined);
  });
});

describe("Gemini strategy end-to-end", () => {
  test("strategy builds correct payload", () => {
    const strategy = new GeminiChatProviderStrategy();
    const context = {
      routeProviderId: "gemini",
      config: {
        cljsPolicyManifestPath: "resources/policies/runtime/00-manifest.edn",
      } as StrategyRequestContext["config"],
      clientHeaders: {},
      requestBody: {
        model: "gemini-2.5-pro",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hello" },
        ],
        temperature: 0.7,
        max_tokens: 100,
      },
      requestAuth: undefined,
      requestedModelInput: "gemini-2.5-pro",
      routingModelInput: "gemini-2.5-pro",
      routedModel: "gemini-2.5-pro",
      explicitOllama: false,
      openAiPrefixed: false,
      factoryPrefixed: false,
      localOllama: false,
      clientWantsStream: false,
      needsReasoningTrace: false,
      upstreamAttemptTimeoutMs: 30000,
      responsesPassthrough: false,
      imagesPassthrough: false,
    };

    const payload = strategy.buildPayload(context);
    const upstreamPayload = payload.upstreamPayload;

    assert.ok(isRecord(upstreamPayload));
    assert.ok(Array.isArray(upstreamPayload.contents));
    assert.equal(upstreamPayload.contents.length, 1);
    assert.equal(upstreamPayload.contents[0].role, "user");
    assert.equal(upstreamPayload.contents[0].parts[0].text, "Hello");
    assert.ok(isRecord(upstreamPayload.systemInstruction));
    const sysParts = upstreamPayload.systemInstruction.parts as Array<{text: string}>;
    assert.equal(sysParts[0]!.text, "Be helpful");
    assert.ok(isRecord(upstreamPayload.generationConfig));
    assert.equal(upstreamPayload.generationConfig.temperature, 0.7);
    assert.equal(upstreamPayload.generationConfig.maxOutputTokens, 100);
  });

  test("strategy matches gemini provider", () => {
    const strategy = new GeminiChatProviderStrategy();

    assert.equal(
      strategy.matches({
        routeProviderId: "gemini",
        responsesPassthrough: false,
        imagesPassthrough: false,
      } as StrategyRequestContext),
      true
    );

    assert.equal(
      strategy.matches({
        routeProviderId: "openai",
        responsesPassthrough: false,
        imagesPassthrough: false,
      } as StrategyRequestContext),
      false
    );
  });

  test("response transformation produces valid downstream shape", () => {
    // This is the critical test - verify the output is exactly what
    // an OpenAI client expects
    const geminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "The answer is 42" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };

    const completion = geminiResponseToChatCompletion(geminiResponse, "gemma4:31b");

    // Verify the exact shape an OpenAI client expects
    assert.ok(completion.id, "Missing id");
    assert.equal(completion.object, "chat.completion");
    assert.ok(typeof completion.created === "number", "created should be a number");
    assert.equal(completion.model, "gemma4:31b");

    const choices = getChoices(completion);
    assert.equal(choices.length, 1);

    const choice = choices[0]!;
    assert.equal(choice.index, 0);
    const message = getMessage(choice);
    assert.ok(isRecord(message), "message should be an object");
    assert.equal(message.role, "assistant");
    assert.ok(typeof message.content === "string", "content should be a string");
    assert.equal(message.content, "The answer is 42");
    assert.ok(!message.reasoning_content, "Should not have reasoning_content when no reasoning");
    assert.equal(choice.finish_reason, "stop");

    const usage = getUsage(completion);
    assert.ok(usage, "usage should be an object");
    assert.equal(usage!.prompt_tokens, 10);
    assert.equal(usage!.completion_tokens, 5);
    assert.equal(usage!.total_tokens, 15);
  });
});
