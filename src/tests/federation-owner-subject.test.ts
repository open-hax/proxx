import assert from "node:assert/strict";
import test from "node:test";

import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";

test("resolveFederationOwnerSubject uses tenant api key subject as owner (not arbitrary header)", () => {
  const resolved = resolveFederationOwnerSubject({
    headers: {
      "x-open-hax-federation-owner-subject": "did:web:big.ussy.promethean.rest",
    },
    requestAuth: {
      kind: "tenant_api_key",
      subject: "tenant_api_key:test-key",
    },
    hopCount: 0,
  });

  assert.equal(resolved, "tenant_api_key:test-key");
});

test("resolveFederationOwnerSubject still rejects explicit owner header for unauthenticated requests", () => {
  const resolved = resolveFederationOwnerSubject({
    headers: {
      "x-open-hax-federation-owner-subject": "did:web:big.ussy.promethean.rest",
    },
    requestAuth: {
      kind: "unauthenticated",
    },
    hopCount: 0,
  });

  assert.equal(resolved, undefined);
});

test("resolveFederationOwnerSubject rejects cross-tenant owner header for tenant api keys", () => {
  const resolved = resolveFederationOwnerSubject({
    headers: {
      "x-open-hax-federation-owner-subject": "did:web:other-tenant.promethean.rest",
    },
    requestAuth: {
      kind: "tenant_api_key",
      subject: "tenant_api_key:tenant-a",
    },
    hopCount: 0,
  });

  assert.equal(resolved, "tenant_api_key:tenant-a");
});
