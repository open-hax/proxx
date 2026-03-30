import assert from "node:assert/strict";
import test from "node:test";

import { accountDisplayName, deriveOAuthMetadataFromToken, openAiReauthIdentityMatches } from "../lib/account-identity.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

test("deriveOAuthMetadataFromToken extracts email subject workspace and plan", () => {
  const token = makeJwt({
    sub: "user-123",
    "https://api.openai.com/profile": {
      email: "Test.User@example.com",
    },
    "https://api.openai.com/auth": {
      chatgpt_account_id: "workspace-123",
      chatgpt_plan_type: "pro",
    },
  });

  assert.deepEqual(deriveOAuthMetadataFromToken(token), {
    email: "test.user@example.com",
    subject: "user-123",
    chatgptAccountId: "workspace-123",
    planType: "pro",
  });
});

test("accountDisplayName prefers email then workspace then id", () => {
  assert.equal(
    accountDisplayName({ id: "acct-1", email: "person@example.com", chatgptAccountId: "workspace-1" }),
    "person@example.com",
  );
  assert.equal(
    accountDisplayName({ id: "acct-2", chatgptAccountId: "workspace-2" }),
    "workspace-2",
  );
  assert.equal(accountDisplayName({ id: "acct-3" }), "acct-3");
});

test("openAiReauthIdentityMatches prefers subject and email and falls back to sparse workspace matches", () => {
  assert.equal(
    openAiReauthIdentityMatches(
      { subject: "user-a", chatgptAccountId: "workspace-1" },
      { subject: "user-a", email: "different@example.com", chatgptAccountId: "workspace-2" },
    ),
    true,
  );

  assert.equal(
    openAiReauthIdentityMatches(
      { email: "person@example.com", chatgptAccountId: "workspace-1" },
      { email: "PERSON@example.com", chatgptAccountId: "workspace-9" },
    ),
    true,
  );

  assert.equal(
    openAiReauthIdentityMatches(
      { chatgptAccountId: "workspace-sparse" },
      { chatgptAccountId: "workspace-sparse" },
    ),
    true,
  );

  assert.equal(
    openAiReauthIdentityMatches(
      { subject: "user-a", chatgptAccountId: "workspace-1" },
      { subject: "user-b", chatgptAccountId: "workspace-1" },
    ),
    false,
  );
});
