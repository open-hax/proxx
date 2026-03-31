import assert from "node:assert/strict";
import test from "node:test";

import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";

test("resolveFederationOwnerSubject accepts explicit owner header for tenant api keys bound to the same owner subject", () => {
  const resolved = resolveFederationOwnerSubject({
    headers: {
      "x-open-hax-federation-owner-subject": "did:web:big.ussy.promethean.rest",
    },
    requestAuth: {
      kind: "tenant_api_key",
      tenantId: "did:web:big.ussy.promethean.rest",
      subject: "tenant_api_key:did:web:big.ussy.promethean.rest",
    },
    hopCount: 0,
  });

  assert.equal(resolved, "did:web:big.ussy.promethean.rest");
});

test("resolveFederationOwnerSubject rejects explicit owner header for tenant api keys bound to a different owner subject", () => {
  const resolved = resolveFederationOwnerSubject({
    headers: {
      "x-open-hax-federation-owner-subject": "did:web:tenant-b.promethean.rest",
    },
    requestAuth: {
      kind: "tenant_api_key",
      tenantId: "did:web:tenant-a.promethean.rest",
      subject: "tenant_api_key:did:web:tenant-a.promethean.rest",
    },
    hopCount: 0,
  });

  assert.equal(resolved, undefined);
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
