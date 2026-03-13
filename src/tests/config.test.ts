import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../lib/config.js";

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig falls back to PORT when PROXY_PORT is unset", async () => {
  await withEnv(
    {
      PROXY_AUTH_TOKEN: "test-token",
      PROXY_PORT: undefined,
      PORT: "9191",
    },
    () => {
      const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
      assert.equal(config.port, 9191);
    },
  );
});
