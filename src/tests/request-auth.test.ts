import assert from "node:assert/strict";
import test from "node:test";

import { resolveRequestAuth } from "../lib/request-auth.js";

test("resolveRequestAuth accepts legacy admin bearer token for default tenant", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: false,
    proxyAuthToken: "test-proxy-token",
    authorization: "Bearer test-proxy-token",
  });

  assert.ok(resolved);
  assert.equal(resolved.kind, "legacy_admin");
  assert.equal(resolved.tenantId, "default");
  assert.equal(resolved.source, "bearer");
});

test("resolveRequestAuth accepts legacy admin cookie token for default tenant", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: false,
    proxyAuthToken: "test-proxy-token",
    cookieToken: "test-proxy-token",
  });

  assert.ok(resolved);
  assert.equal(resolved.kind, "legacy_admin");
  assert.equal(resolved.tenantId, "default");
  assert.equal(resolved.source, "cookie");
});

test("resolveRequestAuth accepts tenant api key bearer token", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: false,
    proxyAuthToken: "test-proxy-token",
    authorization: "Bearer tenant-secret",
    resolveTenantApiKey: async (token) => token === "tenant-secret"
      ? {
          id: "key-1",
          tenantId: "acme",
          label: "CI key",
          prefix: "ohpk_acme",
          scopes: ["proxy:use"],
        }
      : undefined,
  });

  assert.ok(resolved);
  assert.equal(resolved.kind, "tenant_api_key");
  assert.equal(resolved.tenantId, "acme");
  assert.equal(resolved.keyId, "key-1");
  assert.deepEqual(resolved.scopes, ["proxy:use"]);
});

test("resolveRequestAuth accepts tenant api key bearer token when no legacy proxy token is configured", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: false,
    authorization: "Bearer tenant-secret",
    resolveTenantApiKey: async (token) => token === "tenant-secret"
      ? {
          id: "key-2",
          tenantId: "beta",
          label: "automation",
          prefix: "ohpk_beta",
          scopes: ["proxy:use"],
        }
      : undefined,
  });

  assert.ok(resolved);
  assert.equal(resolved.kind, "tenant_api_key");
  assert.equal(resolved.tenantId, "beta");
});

test("resolveRequestAuth allows explicit unauthenticated mode", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: true,
    authorization: undefined,
    cookieToken: undefined,
  });

  assert.ok(resolved);
  assert.equal(resolved.kind, "unauthenticated");
});

test("resolveRequestAuth rejects unknown credentials when auth is required", async () => {
  const resolved = await resolveRequestAuth({
    allowUnauthenticated: false,
    proxyAuthToken: "test-proxy-token",
    authorization: "Bearer something-else",
    resolveTenantApiKey: async () => undefined,
  });

  assert.equal(resolved, undefined);
});
