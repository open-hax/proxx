import assert from "node:assert/strict";
import test from "node:test";

import { resolveFederationOwnerSubject } from "../lib/federation/federation-helpers.js";

test("resolveFederationOwnerSubject accepts explicit owner header for tenant api keys", () => {
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

  assert.equal(resolved, "did:web:big.ussy.promethean.rest");
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
