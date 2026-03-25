import assert from "node:assert/strict";
import test from "node:test";

import { buildForwardHeaders, buildUpstreamHeadersForCredential } from "../lib/proxy.js";

test("forward headers never pass browser cookies upstream", () => {
  const headers = buildForwardHeaders({
    cookie: "session=abc",
    "x-custom-trace": "trace-1",
  });

  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("x-custom-trace"), "trace-1");
});

test("OpenAI OAuth upstream headers strip browser fingerprint headers and inject Codex originator", () => {
  const headers = buildUpstreamHeadersForCredential(
    {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      cookie: "proxy_auth=abc",
      origin: "http://127.0.0.1:5174",
      referer: "http://127.0.0.1:5174/credentials",
      priority: "u=1, i",
      "sec-ch-ua": '"Chromium";v="135"',
      "sec-fetch-site": "same-site",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.10",
      "x-real-ip": "203.0.113.10",
    },
    {
      providerId: "openai",
      accountId: "acc-1",
      token: "access-token-1",
      authType: "oauth_bearer",
      chatgptAccountId: "workspace-a",
    },
    { useOpenAiCodexHeaderProfile: true },
  );

  assert.equal(headers.get("authorization"), "Bearer access-token-1");
  assert.equal(headers.get("chatgpt-account-id"), "workspace-a");
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("accept-language"), null);
  assert.equal(headers.get("origin"), null);
  assert.equal(headers.get("referer"), null);
  assert.equal(headers.get("priority"), null);
  assert.equal(headers.get("sec-ch-ua"), null);
  assert.equal(headers.get("sec-fetch-site"), null);
  assert.equal(headers.get("user-agent"), null);
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("x-real-ip"), null);
});

test("non-OpenAI upstream headers keep caller user-agent when no Codex profile is requested", () => {
  const headers = buildUpstreamHeadersForCredential(
    {
      "user-agent": "Mozilla/5.0",
      "x-custom-trace": "trace-2",
    },
    {
      providerId: "requesty",
      accountId: "acc-2",
      token: "api-key-2",
      authType: "api_key",
    },
  );

  assert.equal(headers.get("authorization"), "Bearer api-key-2");
  assert.equal(headers.get("user-agent"), "Mozilla/5.0");
  assert.equal(headers.get("x-custom-trace"), "trace-2");
  assert.equal(headers.get("originator"), null);
});