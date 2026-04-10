import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRateLimitKind,
  detectOllamaLimitKind,
} from "../lib/proxy.js";

test("classifyRateLimitKind: Ollama session limit → quota_exhausted", () => {
  const body = { error: "Session usage limit reached" };
  assert.equal(classifyRateLimitKind(body, 5000), "quota_exhausted");
});

test("classifyRateLimitKind: Ollama weekly limit → quota_exhausted", () => {
  const body = { error: "Weekly usage limit reached" };
  assert.equal(classifyRateLimitKind(body, 60_000), "quota_exhausted");
});

test("classifyRateLimitKind: concurrent request limit message → concurrency_throttle", () => {
  const body = { error: { message: "Too many concurrent requests. Please try again." } };
  assert.equal(classifyRateLimitKind(body, 5000), "concurrency_throttle");
});

test("classifyRateLimitKind: 'try again in' with short retry → concurrency_throttle", () => {
  const body = { error: { message: "Rate limit reached. Please try again in 5s." } };
  assert.equal(classifyRateLimitKind(body, 5000), "concurrency_throttle");
});

test("classifyRateLimitKind: short retry-after without quota keywords → concurrency_throttle", () => {
  assert.equal(classifyRateLimitKind(undefined, 3000, 30_000), "concurrency_throttle");
});

test("classifyRateLimitKind: short retry-after with body → concurrency_throttle", () => {
  const body = { error: { message: "Slow down please" } };
  assert.equal(classifyRateLimitKind(body, 8000), "concurrency_throttle");
});

test("classifyRateLimitKind: quota-exhaustion message → quota_exhausted even with short retry", () => {
  const body = { error: { message: "Insufficient quota for this account." } };
  assert.equal(classifyRateLimitKind(body, 3000), "quota_exhausted");
});

test("classifyRateLimitKind: billing exhaustion → quota_exhausted", () => {
  const body = { error: { message: "Your account has an outstanding balance." } };
  assert.equal(classifyRateLimitKind(body, 5000), "quota_exhausted");
});

test("classifyRateLimitKind: credit exhaustion → quota_exhausted", () => {
  const body = { error: { message: "Credits exhausted for this plan." } };
  assert.equal(classifyRateLimitKind(body, 10_000), "quota_exhausted");
});

test("classifyRateLimitKind: long retry-after without indicators → quota_exhausted (safe default)", () => {
  assert.equal(classifyRateLimitKind(undefined, 120_000, 30_000), "quota_exhausted");
});

test("classifyRateLimitKind: no body, no retry-after → quota_exhausted (safe default)", () => {
  assert.equal(classifyRateLimitKind(undefined, undefined), "quota_exhausted");
});

test("classifyRateLimitKind: ZAI-style 'too many requests' → concurrency_throttle", () => {
  const body = { error: { message: "Too many requests. Please wait 10.5 seconds before making another request." } };
  assert.equal(classifyRateLimitKind(body, 10_500), "concurrency_throttle");
});

test("classifyRateLimitKind: 'requests per' → concurrency_throttle", () => {
  const body = { error: { message: "You have exceeded your requests per minute limit." } };
  assert.equal(classifyRateLimitKind(body, 5000), "concurrency_throttle");
});

test("classifyRateLimitKind: daily limit → quota_exhausted", () => {
  const body = { error: { message: "You have reached your daily limit." } };
  assert.equal(classifyRateLimitKind(body, 5000), "quota_exhausted");
});

test("classifyRateLimitKind: plan limit → quota_exhausted", () => {
  const body = { error: { message: "Plan limit reached for this billing period." } };
  assert.equal(classifyRateLimitKind(body, 5000), "quota_exhausted");
});

test("classifyRateLimitKind: capacity message → concurrency_throttle", () => {
  const body = { error: { message: "Server is at capacity. Please retry." } };
  assert.equal(classifyRateLimitKind(body, 5000), "concurrency_throttle");
});

test("detectOllamaLimitKind still works: session", () => {
  assert.equal(detectOllamaLimitKind({ error: "Session usage limit reached" }), "session");
});

test("detectOllamaLimitKind still works: weekly", () => {
  assert.equal(detectOllamaLimitKind({ error: "Weekly usage limit reached" }), "weekly");
});

test("detectOllamaLimitKind still works: unknown", () => {
  assert.equal(detectOllamaLimitKind({ error: "Something else" }), "unknown");
});
