# Deterministic Kimi publication ownership and App authentication

This is local source preparation on
`3565585ef507b5c07745b3a368979856e71e822c`. It does not activate a workflow,
enroll Kimi in reviewer quorum, prove a native review or qualify an App token.
The parent owns workflow publication changes and reviewed canonical identity
configuration. The preceding catalog repair and its complete receipt history
remain intact.

## Ownership contract

`publish` and `probe` accept a trusted caller option `publisher`. Its default is
`github-actions`; the only other supported selection is `opencode-agent`.
Neither an arbitrary principal object nor model-supplied ownership is accepted.

| Caller selection | Exact login | Numeric GitHub user ID | Type |
| --- | --- | --- | --- |
| `github-actions` | `github-actions[bot]` | 41898282 | `Bot` |
| `opencode-agent` | `opencode-agent[bot]` | 219766164 | `Bot` |

These identify publication actors, not independent model reviewers. The App
tuple comes from the parent's verified public metadata; local fixtures do not
establish native installation access. No MiMo identity is accepted or reused.

Deduplication requires the selected exact tuple, current commit and submission
marker. A different actor's matching marker cannot authorize an update. Native
creation and readback require a positive safe numeric review ID, that actor,
`COMMENTED`, the exact commit and expected UTF-8 body bytes. Existing submissions
retain their original immutable prefix, trusted footer and native operational
suffix. Publication readbacks guard notification and receipt writes; updates
require another exact readback before the next notification.

All returned inline comments must belong to that actor, native review ID and
commit before any notification is sent. Existing head/base/full-diff coverage,
structured-output, model/low-control provenance, preflight and receipt budgets
remain unchanged. A concurrent native body edit refuses overwrite. Delivery
still has an honest at-least-once boundary: a successful send followed by a
failed receipt write/readback is visible and can redeliver on retry.

The canary remains **API DIAGNOSTIC ONLY — NOT A CODE REVIEW OR APPROVAL**.
It preserves partial creation evidence, verifies login/ID/type/head/native ID,
updates only its own diagnostic, reads back exact body bytes and deduplicates a
rerun. Passing diagnostic transport provides no model judgment or round credit.

## Exchange adapter and workflow boundary

`withOpenCodeAppToken({core, fetchImpl}, use)` obtains
`core.getIDToken("opencode-github-action")`, masks it and sends a no-body POST to
`https://api.opencode.ai/exchange_github_app_token` with a Bearer authorization
header. It accepts only a one-field `{token: string}` JSON object with a bounded,
nonempty, header-safe opaque token, masks the installation token and invokes the
trusted callback. No token prefix, extra response metadata or model credential
is inferred. HTTP redirects are rejected and requests have a 20-second deadline.

The adapter performs `DELETE https://api.github.com/installation/token` in
`finally`. Only HTTP 204 counts as successful revocation. Failures expose a
sanitized phase (`oidc`, `exchange`, `publication` or `revocation`) without raw
exception causes, response bodies or credentials. Both publication and
revocation failures remain visible together. An otherwise usable token in an
invalid extra-field envelope is masked and revoked without publication. If no
usable token was received, no successful revocation is claimed.

The callback and its return value are trusted publisher code; never return,
persist or upload credentials. The adapter has no credential-file reader, Git
configuration writer, model session, automatic invocation or token output.

The parent must invoke it only in a **fresh trusted hosted publication job after
inference**, with `id-token: write`, no model credentials or surviving model
process, and no candidate executable code. The producer/inference job must lack
OIDC permission. Removing a token environment variable in the inference job is
not equivalent to removing its ability to request OIDC. Preserve the existing
single deterministic publisher, footer, deduplication and budget contract.
Workflow files are deliberately outside this patch.

The protocol is verified against OpenCode `v1.18.34`, immutable commit
`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`:
[client](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/cli/cmd/github.handler.ts#L984),
[backend](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/function/src/api.ts#L262).
The response carries no App/installation/permission/expiry attestation. The
backend does not enforce this publication-job boundary or request token
downscoping; GitHub installation access and App permissions still apply.
Do not use the stock action or `github run` to acquire credentials: they combine
authentication with inference/publication, and the stock action installs the
latest CLI. Source pins and inference controls are unchanged here.

## Local verification

Node 22.20.0 baseline: **33/33** existing tests pass. New ownership tests against
unchanged production source initially fail **22/56**. Replaying the final
publisher/canary tests against immutable `3565585` produces **24 failures / 58
tests** (34 pass), including exact ownership, native readback, mixed comments,
App rerun deduplication and concurrent body edits. No setup failure, cancellation
or timeout is counted as semantic RED.

Final prepared source passes **76/76 tests**, with zero failures, cancellations,
skips or todos:

```bash
node --test .github/scripts/kimi-review.test.cjs \
  .github/scripts/kimi-api-canary.test.cjs \
  .github/scripts/opencode-app-auth.test.cjs
```

The auth tests use actual loopback HTTP requests with synthetic credentials,
covering the fixed no-body exchange, invalid JSON/envelopes, reflected error
bodies, masking failure after minting, failed publication and failed revocation.
They make no live OIDC/provider/GitHub call. Publisher fixtures invoke the actual
helper with disposable artifacts and independent native API records, preserving
the existing footer, forged-receipt, partial-retry, control and UTF-8 budget tests.

All six CJS files pass Node syntax checks and scoped ESLint recommended rules
with actual Node globals, zero errors/warnings. The repository's normal ESLint
configuration ignores CJS; it is not credited as checking these files. An
initial scoped lint setup omitted `structuredClone`; its genuine `finally`
control-flow finding was repaired rather than suppressed. `git diff --check`
passes. Evidence, immutable RED source copies, commands and the scoped lint
configuration are under `/tmp/proxx451-publisher-3565585-fyhsvqkw`.

No commit, push, workflow change, canonical enrollment, live authentication,
inference, GitHub mutation, secret inspection or deployment is part of this
preparation. Actual App canary access and exact-head full Kimi review remain
pending parent qualification.
