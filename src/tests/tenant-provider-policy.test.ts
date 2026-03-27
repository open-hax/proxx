import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTenantProviderPolicyInput,
  normalizeTenantProviderShareMode,
  shareModeAllowsCredentialProjection,
  shareModeAllowsRelay,
  shareModeAllowsWarmImport,
  tenantProviderPolicyAllowsUse,
} from "../lib/tenant-provider-policy.js";

test("normalizeTenantProviderShareMode defaults to deny", () => {
  assert.equal(normalizeTenantProviderShareMode(undefined), "deny");
});

test("project_credentials implies relay and warm import", () => {
  assert.equal(shareModeAllowsRelay("project_credentials"), true);
  assert.equal(shareModeAllowsWarmImport("project_credentials"), true);
  assert.equal(shareModeAllowsCredentialProjection("project_credentials"), true);
});

test("normalizeTenantProviderPolicyInput uses simplest MVP defaults", () => {
  const normalized = normalizeTenantProviderPolicyInput({
    subjectDid: "did:web:big.ussy.promethean.rest",
    providerId: "OpenAI",
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    shareMode: "project_credentials",
  });

  assert.equal(normalized.subjectDid, "did:web:big.ussy.promethean.rest");
  assert.equal(normalized.providerId, "openai");
  assert.equal(normalized.providerKind, "local_upstream");
  assert.equal(normalized.shareMode, "project_credentials");
  assert.equal(normalized.trustTier, "less_trusted");
  assert.equal(normalized.encryptedChannelRequired, true);
  assert.deepEqual(normalized.allowedModels, []);
});

test("tenantProviderPolicyAllowsUse enforces share mode, owner, kind, and model", () => {
  const relayOnly = {
    ...normalizeTenantProviderPolicyInput({
      subjectDid: "did:web:big.ussy.promethean.rest",
      providerId: "openai",
      providerKind: "peer_proxx",
      ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
      shareMode: "relay_only",
      allowedModels: ["gpt-5.4"],
    }),
    createdAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z",
  };

  const descriptorOnly = {
    ...relayOnly,
    shareMode: "descriptor_only" as const,
  };

  assert.equal(tenantProviderPolicyAllowsUse(relayOnly, {
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.4",
    requiredShareMode: "relay",
  }), true);

  assert.equal(tenantProviderPolicyAllowsUse(descriptorOnly, {
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.4",
    requiredShareMode: "relay",
  }), false);

  assert.equal(tenantProviderPolicyAllowsUse(relayOnly, {
    ownerSubject: "did:plc:someone-else",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.4",
    requiredShareMode: "relay",
  }), false);

  assert.equal(tenantProviderPolicyAllowsUse(relayOnly, {
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    providerKind: "local_upstream",
    requestedModel: "gpt-5.4",
    requiredShareMode: "relay",
  }), false);

  assert.equal(tenantProviderPolicyAllowsUse(relayOnly, {
    ownerSubject: "did:plc:z72i7hdynmk6r22z27h6tvur",
    providerKind: "peer_proxx",
    requestedModel: "gpt-5.2",
    requiredShareMode: "relay",
  }), false);
});
