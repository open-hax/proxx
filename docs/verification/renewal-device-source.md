# Source handoff: revocable renewal and cross-device sign-in

Source only. No live DB, credentials, real root actor, SSH, Docker, deployment,
commit, PR, canonical ledger, board, or other-thread communication was used.

Keep the existing explicit qualified issuer+subject → existing user linkage.
The authority must explicitly enable `refresh-enabled?` for this confidential
client. Set `AXXIUM_OIDC_DEVICE_ENABLED=true` only for an RFC8628-enabled authority
client. Native login remains available until migration qualification.

Opaque host-only HttpOnly Secure session cookies select bounded in-memory product
records. Access/refresh tokens and device codes stay server-side. Every protected
request still introspects live and rereads local user/membership/tenant policy.
A renewable browser session requires `root_session_expires_at` introspection evidence;
its deadline is the minimum of the initial current parent bound and 24 hours.
Normal response cookies retain only the remaining lifetime. Singleflight rotates
with maintained `refreshTokenGrant`, signatures enabled, issuer/audience/subject
continuity, and original nonce continuity when present. Standard missing nonce on
refresh is accepted. Logout fences asynchronous results and revokes refresh as well
as access tokens; orphaned late rotations are revoked. Broken evidence destroys
local admission. No native/header fallback is permitted with an OIDC cookie.

Device operations are fixed same-origin POST routes under `/api/auth/axxium/device/`.
The backend uses trusted issuer discovery, retains a bounded device code, and
returns only code, pinned verification link, expiry, and interval. A random separate
HttpOnly transaction cookie selects the record. The maintained library owns OAuth
polling/backoff and signature validation; the CLJS browser controller polls only
the product. Cancel/expiry abort the worker and remove sensitive state. Completion
uses the code callback's same local link and membership checks. Device login cannot
create machine federation permission; existing transport restrictions remain.

The browser controller is CLJS (`proxx.browser.device`); React only mounts it.
`pnpm build` generates its ESM in ignored `web/compiled/oidc/` before Vite uses it.
Standalone web build/dev/test commands also generate that browser module, so a
fresh checkout does not depend on a previously generated artifact. No new dependency
is required.

```sh
pnpm build
pnpm typecheck
pnpm test:oidc
pnpm test:cljs
pnpm web:build
pnpm web:test
```

Focused tests cover signed RP refresh, concurrent renewal, subject/nonce substitution,
outage, logout during rotation, device cookie/Origin/cancel/backoff, actual maintained
RP device grant, and browser code/link/poll presentation. Broader CLJS tests pass;
eight existing inference warnings belong to `src/proxx/store/redis.cljs` and
`src/proxx/store/postgres.cljs`. Changed identity targets compile with zero warnings.
ESLint reports the same four existing size/complexity warnings in `config.ts` and
`App.tsx` as the HEAD baseline; no new warning was added.

`web:test` assertions pass; Vite prints a sandbox `listen EPERM` diagnostic for its
HMR listener and an existing React act deprecation. Proxy tests were attempted with
a synthetic token but their ephemeral upstream listeners are forbidden here.
Run the socket-dependent checks from this exact worktree in the parent harness:

```sh
PROXY_AUTH_TOKEN=source-fixture-only pnpm exec tsx --test src/tests/proxy.test.ts
pnpm web:test:e2e
```

Do not substitute a live production token or service for these synthetic fixtures.
Product sessions are intentionally ephemeral and per-process. Restart requires
sign-in; multiple workers require sticky ownership or a shared transactional product
session store. Actual durable authority rotation, consumer-to-authority integration,
real host/client registration, multi-device human UX, and deployment qualification
remain owned by the parent. There is no full migration/deployment acceptance claim.

Transient authority transport, timeout, 5xx and stale-evidence refusals deny the
request while retaining the current server-side session for retry. A successful
refresh stores its rotated credentials under the existing parent deadline before
introspection, since the previous refresh token is already consumed. No route
receives authorization until fresh authority evidence and current local policy
both pass. Confirmed inactive grants, invalid_grant/invalid_token, cryptographic
claim failures, expired root bounds and local account removal still invalidate
admission; cleanup never removes a concurrent successor.

Bridge start/stop generations invalidate pending connection preparation and its
retry scheduling. Capabilities prepared for a retired generation are closed.
Disconnected relay sessions cannot regain cancellation custody when an iterator
finishes later. Regressions cover resolved/rejected preparation races and repeated
disconnect/cancel cycles alongside the existing connected-stream behavior.
