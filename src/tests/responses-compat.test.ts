import assert from "node:assert/strict";
import test from "node:test";

import {
  chatCompletionEventStreamToResponsesEventStream,
  chatRequestToResponsesRequest,
  extractTerminalResponseFromEventStream,
  responsesEventStreamToChatCompletion,
  responsesRequestToChatRequest,
  streamResponsesSseToChatCompletionChunks,
} from "../lib/responses-compat.js";

function sseStreamFromText(streamText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(streamText));
      controller.close();
    },
  });
}

function buildResponsesStreamWithEmptyTerminalOutput(): string {
  return [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_test_1",
        object: "response",
        created_at: 1772516803,
        model: "gpt-5.4",
        status: "in_progress",
        output: [],
      },
    })}\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: {
        id: "rs_test_1",
        type: "reasoning",
        status: "in_progress",
        content: [],
        summary: [],
      },
      output_index: 0,
    })}\n`,
    `event: response.content_part.added\ndata: ${JSON.stringify({
      type: "response.content_part.added",
      item_id: "rs_test_1",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    })}\n`,
    `event: response.reasoning_text.delta\ndata: ${JSON.stringify({
      type: "response.reasoning_text.delta",
      item_id: "rs_test_1",
      output_index: 0,
      content_index: 0,
      delta: "thinking-",
    })}\n`,
    `event: response.reasoning_summary_part.added\ndata: ${JSON.stringify({
      type: "response.reasoning_summary_part.added",
      item_id: "rs_test_1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    })}\n`,
    `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_test_1",
      output_index: 0,
      summary_index: 0,
      delta: "summary",
    })}\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: {
        id: "msg_test_1",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
      output_index: 1,
    })}\n`,
    `event: response.content_part.added\ndata: ${JSON.stringify({
      type: "response.content_part.added",
      item_id: "msg_test_1",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    })}\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_test_1",
      output_index: 1,
      content_index: 0,
      delta: "Hello",
      logprobs: [],
    })}\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: {
        id: "fc_test_1",
        type: "function_call",
        status: "in_progress",
        call_id: "call_test_1",
        name: "bash",
        arguments: "",
      },
      output_index: 2,
    })}\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_test_1",
      output_index: 2,
      call_id: "call_test_1",
      delta: '{"command":"pwd"}',
    })}\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_test_1",
        object: "response",
        created_at: 1772516803,
        model: "gpt-5.4",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    })}\n`,
    "data: [DONE]\n",
    "",
  ].join("\n");
}

test("chatRequestToResponsesRequest preserves assistant reasoning as a reasoning item", () => {
  const payload = chatRequestToResponsesRequest({
    model: "gpt-5.4",
    messages: [
      {
        role: "assistant",
        phase: "commentary",
        reasoning_content: "think-first",
        content: "draft",
      },
      {
        role: "user",
        content: "ship it",
      },
    ],
  }) as any;

  assert.ok(Array.isArray(payload.input));
  assert.equal(payload.input.length, 3);
  assert.deepEqual(payload.input[0], {
    type: "reasoning",
    content: [{ type: "reasoning_text", text: "think-first" }],
    summary: [],
    status: "completed",
  });
  assert.deepEqual(payload.input[1], {
    role: "assistant",
    content: "draft",
    phase: "commentary",
  });
  assert.deepEqual(payload.input[2], {
    role: "user",
    content: "ship it",
  });
});

test("responsesRequestToChatRequest attaches reasoning items to the assistant transcript", () => {
  const payload = responsesRequestToChatRequest({
    model: "gpt-5.4",
    input: [
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "hidden-chain" }],
        summary: [{ type: "summary_text", text: "summary-chain" }],
      },
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "visible-answer" }],
      },
    ],
    stream: false,
  }) as any;

  assert.ok(Array.isArray(payload.messages));
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].role, "assistant");
  assert.equal(payload.messages[0].reasoning_content, "hidden-chainsummary-chain");
  assert.equal(payload.messages[0].phase, "final_answer");
  assert.ok(Array.isArray(payload.messages[0].content));
});

test("responsesEventStreamToChatCompletion reconstructs chat output from official response events", () => {
  const completion = responsesEventStreamToChatCompletion(buildResponsesStreamWithEmptyTerminalOutput(), "gpt-5.4") as any;

  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "gpt-5.4");
  assert.equal(completion.choices[0].message.content, "Hello");
  assert.equal(completion.choices[0].message.reasoning_content, "thinking-summary");
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "bash");
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"command":"pwd"}');
  assert.equal(completion.usage.prompt_tokens, 11);
  assert.equal(completion.usage.completion_tokens_details.reasoning_tokens, 5);
});

test("extractTerminalResponseFromEventStream materializes empty terminal outputs from deltas", () => {
  const response = extractTerminalResponseFromEventStream(buildResponsesStreamWithEmptyTerminalOutput()) as any;

  assert.ok(response);
  assert.equal(response?.id, "resp_test_1");
  assert.equal(response?.output_text, "Hello");
  assert.ok(Array.isArray(response?.output));
  assert.equal(response?.output.length, 3);
  assert.equal(response?.output[0].type, "reasoning");
  assert.equal(response?.output[0].content[0].text, "thinking-");
  assert.equal(response?.output[0].summary[0].text, "summary");
  assert.equal(response?.output[1].type, "message");
  assert.equal(response?.output[1].content[0].text, "Hello");
});

test("streamResponsesSseToChatCompletionChunks emits reasoning and text from official response events", async () => {
  const chunks: string[] = [];

  const result = await streamResponsesSseToChatCompletionChunks(
    sseStreamFromText(buildResponsesStreamWithEmptyTerminalOutput()),
    {
      fallbackModel: "gpt-5.4",
      writeFn: (data) => chunks.push(data),
    },
  );

  const body = chunks.join("");
  assert.equal(result.terminalResponse?.id, "resp_test_1");
  assert.ok(body.includes('"reasoning_content":"thinking-"'));
  assert.ok(body.includes('"reasoning_content":"summary"'));
  assert.ok(body.includes('"content":"Hello"'));
  assert.ok(body.includes('"prompt_tokens":11'));
  assert.ok(body.includes('data: [DONE]'));
});

test("chatCompletionEventStreamToResponsesEventStream emits official response event types", () => {
  const streamText = [
    `data: ${JSON.stringify({
      id: "chatcmpl_test_1",
      object: "chat.completion.chunk",
      created: 1772516803,
      model: "gpt-5.4",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          reasoning_content: "think-",
          content: "Hel",
          tool_calls: [{
            index: 0,
            id: "call_test_1",
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command":"',
            },
          }],
        },
        finish_reason: null,
      }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl_test_1",
      object: "chat.completion.chunk",
      created: 1772516803,
      model: "gpt-5.4",
      choices: [{
        index: 0,
        delta: {
          reasoning_content: "done",
          content: "lo",
          tool_calls: [{
            index: 0,
            function: {
              arguments: 'pwd"}',
            },
          }],
        },
        finish_reason: null,
      }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl_test_1",
      object: "chat.completion.chunk",
      created: 1772516803,
      model: "gpt-5.4",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const translated = chatCompletionEventStreamToResponsesEventStream(streamText, "gpt-5.4");
  assert.ok(translated.includes("response.content_part.added"));
  assert.ok(translated.includes("response.reasoning_text.delta"));
  assert.ok(translated.includes("response.output_text.delta"));
  assert.ok(translated.includes("response.function_call_arguments.delta"));
  assert.ok(translated.includes("response.reasoning_text.done"));
  assert.ok(translated.includes("response.output_text.done"));
  assert.ok(translated.includes("response.function_call_arguments.done"));
  assert.ok(translated.includes("response.completed"));
  assert.ok(!translated.includes("response.reasoning.delta"));
});
