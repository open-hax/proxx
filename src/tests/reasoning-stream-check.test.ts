import assert from "node:assert/strict";
import test from "node:test";

import {
  streamPayloadHasReasoningTrace,
  chatCompletionHasReasoningContent,
} from "../lib/provider-utils.js";

test("streamPayloadHasReasoningTrace detects chat completions reasoning_content", () => {
  const payload = [
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"}}]}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects chat completions reasoning field", () => {
  const payload = [
    "data: {\"choices\":[{\"delta\":{\"reasoning\":\"thinking...\"}}]}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.reasoning.delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning.delta\",\"delta\":\"some reasoning\"}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.reasoning_text.delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":{\"text\":\"some reasoning\"}}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.reasoning_summary.delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning_summary.delta\",\"delta\":\"summary text\"}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.reasoning_summary_text.delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":{\"text\":\"summary text\"}}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.reasoning_summary_part.delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning_summary_part.delta\",\"delta\":{\"text\":\"part text\"}}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace detects response.output_item.added reasoning item", () => {
  const payload = [
    "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\",\"text\":\"chain\"}}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace returns false for empty reasoning delta", () => {
  const payload = [
    "data: {\"type\":\"response.reasoning.delta\",\"delta\":\"\"}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(!streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace returns false for non-reasoning responses stream", () => {
  const payload = [
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
    "data: [DONE]",
  ].join("\n");
  assert.ok(!streamPayloadHasReasoningTrace(payload));
});

test("streamPayloadHasReasoningTrace returns false for empty stream", () => {
  assert.ok(!streamPayloadHasReasoningTrace(""));
  assert.ok(!streamPayloadHasReasoningTrace("data: [DONE]"));
});

test("chatCompletionHasReasoningContent checks both reasoning_content and reasoning", () => {
  assert.ok(chatCompletionHasReasoningContent({
    choices: [{ delta: { reasoning_content: "thinking" } }],
  }));
  assert.ok(chatCompletionHasReasoningContent({
    choices: [{ delta: { reasoning: "thinking" } }],
  }));
  assert.ok(chatCompletionHasReasoningContent({
    reasoning_content: "top-level reasoning",
  }));
  assert.ok(chatCompletionHasReasoningContent({
    reasoning: "top-level reasoning",
  }));
  assert.ok(!chatCompletionHasReasoningContent({
    choices: [{ delta: { content: "no reasoning here" } }],
  }));
});
