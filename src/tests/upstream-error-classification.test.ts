import assert from "node:assert/strict";
import test from "node:test";

import { readUpstreamErrorMessage, responseIndicatesModelNotSupportedForAccount } from "../lib/errors/classification.js";

test("readUpstreamErrorMessage reads JSON and text errors without consuming the body", async () => {
  const json = new Response(
    JSON.stringify({ error: { code: 403, message: "Key limit exceeded (total limit)." } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
  assert.equal(await readUpstreamErrorMessage(json), "Key limit exceeded (total limit).");
  assert.equal((await json.json() as { error: { message: string } }).error.message, "Key limit exceeded (total limit).");

  const text = new Response(
    "error, status code: 403, message: You've reached your 5-hour usage limit",
    { status: 403, headers: { "content-type": "text/plain" } },
  );
  assert.match((await readUpstreamErrorMessage(text)) ?? "", /5-hour usage limit/);

  const stream = new Response("data: {}\n\n", { status: 403, headers: { "content-type": "text/event-stream" } });
  assert.equal(await readUpstreamErrorMessage(stream), undefined);

  const ok = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await readUpstreamErrorMessage(ok), undefined);
});

test("ollama-cloud subscription-gated 403 is treated as model-not-supported-for-account", async () => {
  const response = new Response(
    JSON.stringify({
      error: "this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: test-ref)",
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
      },
    },
  );

  const result = await responseIndicatesModelNotSupportedForAccount(response, "glm-5");
  assert.equal(result, true);
});

test("unauthorized 401 is not treated as model-not-supported-for-account", async () => {
  const response = new Response(
    JSON.stringify({
      error: "unauthorized",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );

  const result = await responseIndicatesModelNotSupportedForAccount(response, "gemma4:31b");
  assert.equal(result, false);
});

test("model access denied wording is treated as model-not-supported-for-account", async () => {
  const response = new Response(
    JSON.stringify({
      error: { message: "account is not allowed to call glm-5 on this plan" },
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
      },
    },
  );

  const result = await responseIndicatesModelNotSupportedForAccount(response, "glm-5");
  assert.equal(result, true);
});
