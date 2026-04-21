import assert from "node:assert/strict";
import test from "node:test";

import { responseIndicatesModelNotSupportedForAccount } from "../lib/errors/classification.js";

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