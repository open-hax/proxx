import assert from "node:assert/strict";
import test, { describe } from "node:test";

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

describe("configuration environment fixtures", { concurrency: false }, () => {
  test("loadConfig falls back to PORT when PROXY_PORT is unset", { concurrency: false }, async () => {
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

  test("loadConfig defaults OPENAI_RESPONSES_PATH to /codex/responses", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
        OPENAI_RESPONSES_PATH: undefined,
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.openaiResponsesPath, "/codex/responses");
      },
    );
  });

  test("loadConfig reads CLJS policy authoritative flag", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
        PROXX_CLJS_POLICY_AUTHORITATIVE: "true",
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.cljsPolicyAuthoritative, true);
      },
    );
  });

  test("loadConfig preserves OPENAI_RESPONSES_PATH override", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
        OPENAI_RESPONSES_PATH: "/v1/responses",
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.openaiResponsesPath, "/v1/responses");
      },
    );
  });

  test("loadConfig falls back to session secret for proxy token pepper", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
        SESSION_SECRET: "session-secret-a",
        PROXY_TOKEN_PEPPER: undefined,
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.proxyTokenPepper, "session-secret-a");
      },
    );
  });

  test("loadConfig preserves explicit PROXY_TOKEN_PEPPER", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
        SESSION_SECRET: "session-secret-a",
        PROXY_TOKEN_PEPPER: "pepper-b",
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.proxyTokenPepper, "pepper-b");
      },
    );
  });

  test("loadConfig derives upstream base URL from default provider id", { concurrency: false }, async () => {
    await withEnv(
      {
        PROXY_AUTH_TOKEN: "test-token",
      },
      () => {
        const config = loadConfig("/tmp/open-hax-openai-proxy-config-test");
        assert.equal(config.upstreamBaseUrl, "https://api.vivgrid.com");
        assert.equal(config.upstreamProviderBaseUrls.vivgrid, "https://api.vivgrid.com");
      },
    );
  });
});
