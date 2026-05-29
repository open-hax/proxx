import assert from "node:assert";
import { describe, test } from "node:test";
import { messagesToChatCompletion } from "../lib/messages-compat.js";
import { isRecord } from "../lib/provider-strategy/shared.js";

function getChoices(completion: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(completion.choices) ? completion.choices as Array<Record<string, unknown>> : [];
}

function getMessage(choice: Record<string, unknown>): Record<string, unknown> {
  return isRecord(choice.message) ? choice.message : {};
}

function getUsage(completion: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(completion.usage) ? completion.usage : undefined;
}

describe("Anthropic messages → OpenAI chat completion transformation", () => {
  test("basic text response", () => {
    const anthropicResponse = {
      id: "msg_01Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "text", text: "Hello! How can I help you today?" }
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 15,
        output_tokens: 9
      }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, "claude-3-5-sonnet-20241022");

    const choices = getChoices(completion);
    assert.equal(choices.length, 1);
    const message = getMessage(choices[0]!);
    assert.equal(message.role, "assistant");
    assert.equal(message.content, "Hello! How can I help you today?");
    assert.equal(choices[0]!.finish_reason, "stop");
    assert.ok(!message.tool_calls);
    assert.ok(!message.reasoning_content);

    const usage = getUsage(completion);
    assert.ok(usage);
    assert.equal(usage!.prompt_tokens, 15);
    assert.equal(usage!.completion_tokens, 9);
    assert.equal(usage!.total_tokens, 24);
  });

  test("thinking/reasoning content is extracted", () => {
    const anthropicResponse = {
      id: "msg_02Example",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-20251101",
      content: [
        { type: "thinking", thinking: "Let me analyze this step by step..." },
        { type: "text", text: "The answer is 42." }
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 20,
        output_tokens: 50
      }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-opus-4");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "The answer is 42.");
    assert.equal(message.reasoning_content, "Let me analyze this step by step...");
  });

  test("tool_use produces tool_calls and sets content to null", () => {
    const anthropicResponse = {
      id: "msg_03Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        {
          type: "tool_use",
          id: "tu_01ABC123",
          name: "get_weather",
          input: { location: "San Francisco", unit: "celsius" }
        }
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 30,
        output_tokens: 25
      }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.strictEqual(message.content, null);
    assert.equal(choices[0]!.finish_reason, "tool_calls");

    assert.ok(Array.isArray(message.tool_calls));
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);

    const toolCall = toolCalls[0]!;
    assert.equal(toolCall.id, "tu_01ABC123");
    assert.equal(toolCall.type, "function");

    const func = toolCall.function as Record<string, unknown>;
    assert.equal(func.name, "get_weather");
    assert.equal(func.arguments, '{"location":"San Francisco","unit":"celsius"}');
  });

  test("mixed text and tool_use", () => {
    const anthropicResponse = {
      id: "msg_04Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "text", text: "I'll check the weather for you." },
        {
          type: "tool_use",
          id: "tu_02DEF456",
          name: "get_weather",
          input: { location: "New York" }
        }
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 25,
        output_tokens: 30
      }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "I'll check the weather for you.");
    assert.equal(choices[0]!.finish_reason, "tool_calls");

    assert.ok(Array.isArray(message.tool_calls));
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!.id, "tu_02DEF456");
  });

  test("multiple tool_uses", () => {
    const anthropicResponse = {
      id: "msg_05Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        {
          type: "tool_use",
          id: "tu_03GHI789",
          name: "get_weather",
          input: { location: "SF" }
        },
        {
          type: "tool_use",
          id: "tu_04JKL012",
          name: "get_time",
          input: { timezone: "PST" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 40, output_tokens: 50 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;

    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0]!.id, "tu_03GHI789");
    assert.equal(toolCalls[1]!.id, "tu_04JKL012");
    assert.equal((toolCalls[0]!.function as Record<string, unknown>).name, "get_weather");
    assert.equal((toolCalls[1]!.function as Record<string, unknown>).name, "get_time");
  });

  test("empty content array", () => {
    const anthropicResponse = {
      id: "msg_06Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 0 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "");
    assert.equal(choices[0]!.finish_reason, "stop");
    assert.ok(!message.tool_calls);
  });

  test("string content (edge case)", () => {
    const anthropicResponse = {
      id: "msg_07Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: "Plain string response",
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "Plain string response");
  });

  test("cached token details", () => {
    const anthropicResponse = {
      id: "msg_08Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "Cached response" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        cache_read_input_tokens: 900
      }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const usage = getUsage(completion);
    assert.ok(usage);
    assert.equal(usage!.prompt_tokens, 1000);
    assert.equal(usage!.completion_tokens, 50);
    assert.equal(usage!.total_tokens, 1050);

    const details = usage!["prompt_tokens_details"] as Record<string, unknown> | undefined;
    assert.ok(details);
    assert.equal(details!.cached_tokens, 900);
  });

  test("model field fallback", () => {
    const anthropicResponse = {
      id: "msg_09Example",
      type: "message",
      role: "assistant",
      // model field missing
      content: [{ type: "text", text: "test" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-opus-4-6");
    assert.equal(completion.model, "claude-opus-4-6");
  });

  test("reasoning with text field instead of thinking field", () => {
    const anthropicResponse = {
      id: "msg_10Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "reasoning", text: "Analyzing..." },
        { type: "text", text: "Done!" }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.reasoning_content, "Analyzing...");
  });

  test("text with thought flag", () => {
    const anthropicResponse = {
      id: "msg_11Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "text", text: "Internal thought", thought: true },
        { type: "text", text: "External response" }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 15 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    // thought=true text appears in both reasoning_content and content
    assert.equal(message.reasoning_content, "Internal thought");
    assert.equal(message.content, "Internal thoughtExternal response");
  });

  test("tool_use with string input", () => {
    const anthropicResponse = {
      id: "msg_12Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        {
          type: "tool_use",
          id: "tu_05MNO345",
          name: "query_db",
          input: "SELECT * FROM users"
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 10 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    const func = toolCalls[0]!.function as Record<string, unknown>;
    assert.equal(func.arguments, "SELECT * FROM users");
  });

  test("ensures content is never undefined for non-tool responses", () => {
    const anthropicResponse = {
      id: "msg_13Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 0 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.strictEqual(message.content, "");
    assert.ok(message.content !== null);
    assert.ok(message.content !== undefined);
  });

  test("complex multi-part response", () => {
    const anthropicResponse = {
      id: "msg_14Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [
        { type: "thinking", thinking: "Step 1: understand the problem" },
        { type: "thinking", thinking: "Step 2: formulate answer" },
        { type: "text", text: "First part." },
        { type: "text", text: "Second part." }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 100 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const choices = getChoices(completion);
    const message = getMessage(choices[0]!);
    assert.equal(message.content, "First part.Second part.");
    assert.equal(message.reasoning_content, "Step 1: understand the problemStep 2: formulate answer");
  });
});

describe("Anthropic messages transformation edge cases", () => {
  test("throws on non-record body", () => {
    assert.throws(() => {
      messagesToChatCompletion(null, "claude-3-5-sonnet");
    }, /Invalid \/v1\/messages response payload/);
  });

  test("handles missing usage gracefully", () => {
    const anthropicResponse = {
      id: "msg_15Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "No usage" }],
      stop_reason: "end_turn"
      // no usage field
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const usage = getUsage(completion);
    assert.ok(!usage);
  });

  test("handles partial usage (only input_tokens)", () => {
    const anthropicResponse = {
      id: "msg_16Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "Partial" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10 }
      // no output_tokens
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");

    const usage = getUsage(completion);
    assert.ok(!usage); // Should not include usage if both tokens aren't present
  });

  test("preserves system_fingerprint field", () => {
    const anthropicResponse = {
      id: "msg_17Example",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "test" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");
    assert.equal(completion.system_fingerprint, "");
  });

  test("generates id when missing", () => {
    const anthropicResponse = {
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "test" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    };

    const completion = messagesToChatCompletion(anthropicResponse, "claude-3-5-sonnet");
    assert.ok(typeof completion.id === "string");
    assert.ok(completion.id.startsWith("chatcmpl_"));
  });
});
