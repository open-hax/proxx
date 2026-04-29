import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintAdminKey,
  isAtDid,
  normalizeAtDid,
  parseFederationOwnerCredential,
} from "../lib/federation/owner-credential.js";
import { shouldWarmImportProjectedAccount, WARM_IMPORT_REQUEST_THRESHOLD } from "../lib/db/sql-federation-store.js";

test("isAtDid accepts did:plc and did:web subjects", () => {
  assert.equal(isAtDid("did:plc:z72i7hdynmk6r22z27h6tvur"), true);
  assert.equal(isAtDid("did:web:proxx.promethean.rest"), true);
  assert.equal(isAtDid("did:web:proxx.promethean.rest:peer:local"), true);
});

test("isAtDid rejects non-atproto subjects", () => {
  assert.equal(isAtDid(undefined), false);
  assert.equal(isAtDid(""), false);
  assert.equal(isAtDid("not-a-did"), false);
  assert.equal(isAtDid("did:key:z6Mkabc"), false);
});

test("normalizeAtDid lowercases did:web hosts while preserving path case", () => {
  assert.equal(normalizeAtDid("DID:WEB:PROXX.PROMETHEAN.REST"), "did:web:proxx.promethean.rest");
  assert.equal(normalizeAtDid("did:web:Proxx.Promethean.Rest:Peer:Local"), "did:web:proxx.promethean.rest:Peer:Local");
  assert.equal(normalizeAtDid("did:web:Proxx.Promethean.Rest/Peer/Local"), "did:web:proxx.promethean.rest/Peer/Local");
  assert.throws(() => normalizeAtDid("did:key:z6Mkabc"));
});

test("parseFederationOwnerCredential treats at dids as canonical owner subjects", () => {
  const parsed = parseFederationOwnerCredential("did:plc:z72i7hdynmk6r22z27h6tvur");
  assert.deepEqual(parsed, {
    kind: "at_did",
    value: "did:plc:z72i7hdynmk6r22z27h6tvur",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
  });
});

test("parseFederationOwnerCredential fingerprints admin keys into stable owner subjects", () => {
  const parsed = parseFederationOwnerCredential("super-secret-admin-key");
  assert.ok(parsed);
  assert.equal(parsed?.kind, "admin_key");
  assert.equal(parsed?.value, "super-secret-admin-key");
  assert.equal(parsed?.ownerSubject, `legacy_admin_key:${fingerprintAdminKey("super-secret-admin-key")}`);
});

test("shouldWarmImportProjectedAccount flips true at the warm threshold", () => {
  assert.equal(shouldWarmImportProjectedAccount(WARM_IMPORT_REQUEST_THRESHOLD - 1), false);
  assert.equal(shouldWarmImportProjectedAccount(WARM_IMPORT_REQUEST_THRESHOLD), true);
  assert.equal(shouldWarmImportProjectedAccount(WARM_IMPORT_REQUEST_THRESHOLD + 2), true);
});
