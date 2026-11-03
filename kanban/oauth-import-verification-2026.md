---
uuid: "53a04126-e3f0-4526-a387-68ae8038864c"
title: "OAuth import: adapt to 2026-06 OpenAI verification email + endpoint changes"
status: incoming
priority: P2
labels: ["oauth", "scripts", "maintenance"]
created_at: "2026-06-08T01:42:23.000Z"
source: "kanban/oauth-import-verification-2026.md"
category: "scripts"
---

# OAuth import: adapt to 2026-06 OpenAI verification email + endpoint changes

Retroactive task for working-tree changes to the OpenAI account OAuth import tooling.

## Changes

### `scripts/bulk-oauth-import.ts`
- **New verification-email format (2026-06):** OpenAI now sends
  "Enter this temporary verification code to continue: NNNNNN." Added a primary matcher for it,
  kept the old "Your ChatGPT code is NNNNNN" matcher, and broadened the fallback matchers
  (incl. a last-resort "code … NNNNNN" near-match).
- **IMAP search broadened** from subject `"ChatGPT code"` to `"ChatGPT"` so the new-format mails
  (different subject) are found.
- **Corrected proxy endpoints:** `/api/ui/credentials/openai/oauth/browser/start` →
  `/api/v1/credentials/openai/oauth/browser/start`; callback now posts to
  `/api/v1/credentials/openai/oauth/browser/callback` instead of `/auth/callback`.
- **Phone-required detection:** throw `Phone number required` when OpenAI demands a phone number
  (so the row is reported and skipped rather than hanging).
- **Fail-fast:** `break` the account loop on an unexpected failure instead of grinding through.

### `scripts/debug-emails.cjs`
- Ad-hoc IMAP helper for inspecting verification emails.
- **Security:** removed a hardcoded Gmail address + app password; now reads `GMAIL_USER` /
  `GMAIL_APP_PASSWORD` (and optional `IMAP_HOST`) from env and exits if unset.

## Action item (outside the repo)
- The previously-hardcoded Gmail app password was committed to disk in plaintext and must be
  **revoked/rotated** in the Google account regardless of this cleanup.

## Acceptance criteria
- Import resolves codes from the 2026-06 email format end to end.
- OAuth start/callback hit the `/api/v1/credentials/...` routes.
- No secret is present in source; debug helper sources creds from env.
