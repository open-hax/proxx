import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAuthError,
  classifyModelNotSupported,
  shouldRetrySameCredentialForServerError,
  shouldCooldownCredentialOnAuthFailure,
  shouldPermanentlyDisableCredential,
  PERMANENT_DISABLE_COOLDOWN_MS,
} from "../lib/provider-strategy/routing/error-classifier.js";

test("shouldRetrySameCredentialForServerError returns true for 502/503/504", () => {
  assert.ok(shouldRetrySameCredentialForServerError(502));
  assert.ok(shouldRetrySameCredentialForServerError(503));
  assert.ok(shouldRetrySameCredentialForServerError(504));
  assert.ok(!shouldRetrySameCredentialForServerError(400));
  assert.ok(!shouldRetrySameCredentialForServerError(429));
  assert.ok(!shouldRetrySameCredentialForServerError(500));
});

test("shouldCooldownCredentialOnAuthFailure cools down on 401, and 403 except factory", () => {
  assert.ok(shouldCooldownCredentialOnAuthFailure("openai", 401));
  assert.ok(shouldCooldownCredentialOnAuthFailure("factory", 401));
  assert.ok(shouldCooldownCredentialOnAuthFailure("openai", 403));
  assert.ok(!shouldCooldownCredentialOnAuthFailure("factory", 403));
  assert.ok(!shouldCooldownCredentialOnAuthFailure("openai", 402));
});

test("shouldPermanentlyDisableCredential only disables api_key accounts", () => {
  const apiKey = { providerId: "vivgrid", accountId: "1", token: "x", authType: "api_key" as const };
  const oauth = { providerId: "openai", accountId: "1", token: "x", authType: "oauth_bearer" as const };

  assert.ok(shouldPermanentlyDisableCredential(apiKey, 402));
  assert.ok(shouldPermanentlyDisableCredential(apiKey, 403));
  assert.ok(!shouldPermanentlyDisableCredential(apiKey, 401));
  assert.ok(!shouldPermanentlyDisableCredential(oauth, 402));
  assert.ok(!shouldPermanentlyDisableCredential(oauth, 403));

  // Requesty is an exception for 403
  const requesty = { providerId: "requesty", accountId: "1", token: "x", authType: "api_key" as const };
  assert.ok(!shouldPermanentlyDisableCredential(requesty, 403));
  assert.ok(shouldPermanentlyDisableCredential(requesty, 402));
});

test("classifyAuthError returns permanent disable for api_key 402/403", () => {
  const apiKey = { providerId: "vivgrid", accountId: "1", token: "x", authType: "api_key" as const };
  const result = classifyAuthError(apiKey, "vivgrid", 402, 300_000);
  assert.equal(result.classification, "auth_permanent_disable");
  assert.equal(result.cooldownMs, PERMANENT_DISABLE_COOLDOWN_MS);
});

test("classifyAuthError returns cooldown for OAuth 401", () => {
  const oauth = { providerId: "openai", accountId: "1", token: "x", authType: "oauth_bearer" as const };
  const result = classifyAuthError(oauth, "openai", 401, 300_000);
  assert.equal(result.classification, "auth_cooldown");
  assert.equal(result.cooldownMs, 10_000);
});

test("classifyAuthError returns transient for non-actionable errors", () => {
  const oauth = { providerId: "openai", accountId: "1", token: "x", authType: "oauth_bearer" as const };
  const result = classifyAuthError(oauth, "openai", 500, 300_000);
  assert.equal(result.classification, "transient");
  assert.equal(result.cooldownMs, undefined);
});

test("classifyModelNotSupported returns model_not_supported with capped cooldown", () => {
  const result = classifyModelNotSupported(300_000);
  assert.equal(result.classification, "model_not_supported");
  assert.equal(result.cooldownMs, 60_000);

  const result2 = classifyModelNotSupported(10_000);
  assert.equal(result2.cooldownMs, 10_000);
});
