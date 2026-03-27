import assert from "node:assert/strict";
import test from "node:test";

import { parseWaitTimeFromMessage, parseRetryAfterMs, extractRateLimitCooldownMs } from "../lib/proxy.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseRetryAfterMs tests
// ─────────────────────────────────────────────────────────────────────────────

test("parseRetryAfterMs parses seconds as number", () => {
  assert.equal(parseRetryAfterMs("30"), 30000);
  assert.equal(parseRetryAfterMs("1.5"), 1500);
  assert.equal(parseRetryAfterMs("0"), 0);
});

test("parseRetryAfterMs parses HTTP date format", () => {
  const future = new Date(Date.now() + 60000).toUTCString();
  const result = parseRetryAfterMs(future);
  assert.ok(result !== undefined && result > 55000 && result < 65000);
});

test("parseRetryAfterMs returns undefined for invalid input", () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  assert.equal(parseRetryAfterMs("invalid"), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWaitTimeFromMessage tests
// ─────────────────────────────────────────────────────────────────────────────

test("parseWaitTimeFromMessage extracts seconds from 'wait X seconds'", () => {
  assert.equal(parseWaitTimeFromMessage("Please wait 23.5 seconds before making another request."), 23500);
  assert.equal(parseWaitTimeFromMessage("Please wait 1 second."), 1000);
  assert.equal(parseWaitTimeFromMessage("wait 0.5 seconds"), 500);
});

test("parseWaitTimeFromMessage extracts seconds from 'try again in Xs'", () => {
  assert.equal(parseWaitTimeFromMessage("Please try again in 1.37s."), 1370);
  assert.equal(parseWaitTimeFromMessage("Rate limit reached. Try again in 30s"), 30000);
});

test("parseWaitTimeFromMessage extracts minutes from 'wait X minutes'", () => {
  assert.equal(parseWaitTimeFromMessage("Please wait 2 minutes before retrying."), 120000);
  assert.equal(parseWaitTimeFromMessage("Wait 1 minute."), 60000);
});

test("parseWaitTimeFromMessage extracts combined minutes and seconds (Xm Ys)", () => {
  assert.equal(parseWaitTimeFromMessage("Please wait 2m 30s before making another request."), 150000);
  assert.equal(parseWaitTimeFromMessage("try again in 5m 0s"), 300000);
});

test("parseWaitTimeFromMessage extracts hours", () => {
  assert.equal(parseWaitTimeFromMessage("Please wait 1 hour before retrying."), 3600000);
  assert.equal(parseWaitTimeFromMessage("Wait 2 hours."), 7200000);
});

test("parseWaitTimeFromMessage extracts days", () => {
  assert.equal(parseWaitTimeFromMessage("Please wait 1 day."), 86400000);
  assert.equal(parseWaitTimeFromMessage("Wait 3 days."), 259200000);
});

test("parseWaitTimeFromMessage is case-insensitive", () => {
  assert.equal(parseWaitTimeFromMessage("PLEASE WAIT 5 SECONDS"), 5000);
  assert.equal(parseWaitTimeFromMessage("Wait 5 Seconds before making another request."), 5000);
});

test("parseWaitTimeFromMessage returns undefined for messages without timing", () => {
  assert.equal(parseWaitTimeFromMessage("Rate limit exceeded."), undefined);
  assert.equal(parseWaitTimeFromMessage("Service temporarily unavailable."), undefined);
  assert.equal(parseWaitTimeFromMessage(""), undefined);
  assert.equal(parseWaitTimeFromMessage("Too many requests."), undefined);
});

test("parseWaitTimeFromMessage handles OpenAI-style messages", () => {
  assert.equal(
    parseWaitTimeFromMessage("You are sending requests too quickly. Please wait 23.5 seconds before making another request."),
    23500
  );
  assert.equal(
    parseWaitTimeFromMessage("Rate limit reached for requests. Please wait 1.37s."),
    1370
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// extractRateLimitCooldownMs tests
// ─────────────────────────────────────────────────────────────────────────────

test("extractRateLimitCooldownMs prefers retry-after header", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "Please wait 100 seconds" } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "5"
      }
    }
  );

  const result = await extractRateLimitCooldownMs(response);
  // Header says 5 seconds (5000ms), body says 100 seconds (100000ms)
  // Header should take precedence
  assert.equal(result, 5000);
});

test("extractRateLimitCooldownMs extracts from body when header is missing", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "Please wait 30 seconds before making another request." } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json"
      }
    }
  );

  const result = await extractRateLimitCooldownMs(response);
  assert.equal(result, 30000);
});

test("extractRateLimitCooldownMs returns undefined when no timing info available", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "Rate limit exceeded" } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json"
      }
    }
  );

  const result = await extractRateLimitCooldownMs(response);
  assert.equal(result, undefined);
});

test("extractRateLimitCooldownMs returns undefined for non-JSON response", async () => {
  const response = new Response(
    "Rate limit exceeded",
    {
      status: 429,
      headers: {
        "content-type": "text/plain"
      }
    }
  );

  const result = await extractRateLimitCooldownMs(response);
  assert.equal(result, undefined);
});

test("extractRateLimitCooldownMs handles malformed JSON gracefully", async () => {
  const response = new Response(
    "not json",
    {
      status: 429,
      headers: {
        "content-type": "application/json"
      }
    }
  );

  // Should not throw, returns undefined
  const result = await extractRateLimitCooldownMs(response);
  assert.equal(result, undefined);
});

test("extractRateLimitCooldownMs extracts timing from nested error object", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "Please try again in 2 minutes." } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json"
      }
    }
  );

  const result = await extractRateLimitCooldownMs(response);
  assert.equal(result, 120000);
});