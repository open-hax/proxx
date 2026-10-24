# Axxium scoped machine relay

This is source implementation, not runtime acceptance. Operators must verify real
human sign-in and explicitly authorize real node grants in the private Axxium
configuration. Test fixtures use synthetic actors and keys only.

The trust source is the operator's Axxium `node-grants`, independent of browser
OIDC clients. The paired authority `docs/relay-node-grants.md` specifies schema,
renewal and revocation. No automatic subject, email or host-DID linkage exists.

## Broker

Configure all three settings together:

```text
AXXIUM_RELAY_ISSUER=https://authority.example/oidc
AXXIUM_RELAY_AUDIENCE=https://broker.example
AXXIUM_RELAY_NODES=[{"nodeId":"synthetic-node","subject":"synthetic-example-only"}]
```

These are explicit operator trust pins. The broker node list is an independent
closed list of allowed node/owner pairs, not a public enrollment endpoint. The
issuer ends at `/oidc`, audience is the exact HTTPS broker origin, and verification
fetches only that issuer's `/jwks`. JOSE pins RS256 and `axxium-relay+jwt`; pure
`.cljc` contracts additionally require exact issuer/audience/scope, listed owner
and node, bounded unique exact model names and required broker-local tenant IDs, `jti`, grant revision, integer times,
positive lifetime <=25 seconds, and at most one second future issuance skew.
Expiration has no grace period. Invalid leases never acquire native privileges.

The CLJS runtime and PostgreSQL federation store are mandatory on both broker and
scoped node when configured. There is no memory replay fallback at either end.
Schema version 9 adds `federation_relay_lease_uses`; use the existing migration
runner. Replay admission is atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
keyed by `(issuer,jti)`. It rejects concurrent reuse and persists across broker
restarts. Expired rows are deleted during admission only after a 60 second safety
margin. Database failure refuses authentication. There is no in-memory fallback.

Scoped leases authenticate **only** `/api/ui/federation/bridge/ws`. They do not
enter ordinary request authentication and cannot access admin/settings/accounts,
observability websocket, credential synchronization, or SSE routes. Existing
browser OIDC refusal of node enrollment/upgrades is unchanged. Existing native
bridge and SSE authentication remain available during migration.

The existing websocket protocol uses `agentId` as its bridge identifier; it has
no `bridgeId` field. Signed `node_id` must equal `hello.agentId`; topology nodes
must also match. `hello.ownerSubject` must equal the canonical qualified owner
`axxium:<issuer-character-count>:<issuer>:<subject>`. The broker stores the owner
from the verified lease, and closes the socket and fails pending delivery at
lease expiry, including stalled handshakes. Buffered undelivered chunks are
cleared. This gives normally progressing event loops a <=25 second residual
window after authority-side grant revocation/actor disable. An explicit `reauthorize` frame carries a freshly signed lease and the previous
lease's `jti` on the existing websocket. The agent renews about every 10 seconds,
singleflight until an acknowledgement. Both ends verify the new signature and
pure renewal law. The broker advances its expiry timer only after native signature
verification and durable atomic one-use consumption complete. The local agent
also advances only its own verified generation, and rearms its timer after the
matching broker acknowledgement. Async results cannot revive closed generations.

Renewal requires the exact same issuer/subject/node/audience/type/scope, a fresh
`jti`, a live exact predecessor, nondecreasing issuance and a later expiry. A
revision change is accepted only for strict model/tenant scope narrowing. Replayed,
superseded, widened or mismatched grants close the connection. Narrowing cancels
unauthorized queued/inflight delivery while still-authorized streams continue.
Failed issuance/verification/storage never extends the accepted deadline; an
outage, grant removal or actor disable stops work within the last <=25s lease
under progressing clocks/event loops. No operation is transparently retried.

Verified browser users route by the same qualified issuer/subject. For scoped
node sessions, route selection requires the matching verified OIDC identity and
an admitted local tenant explicitly named in the signed `allowed_tenants` claim.
Missing/empty scope never means any tenant. Authority grants use required
`allowed-tenants`; these IDs are broker-local and audience-scoped. The central
issuer/subject is portable, while local membership and tenant IDs are not. The
same verified person on another valid tenant is refused. A legacy admin's owner override cannot impersonate that
user for node routing. Native bridges preserve owner plus tenant matching. This
does not grant remote roles, invent a local membership, or import provider keys.

## Node agent

Set `FEDERATION_BRIDGE_RELAY_URL` to
`wss://broker.example/api/ui/federation/bridge/ws` and configure:

```text
AXXIUM_RELAY_NODE_ISSUER=https://authority.example/oidc
AXXIUM_RELAY_NODE_AUDIENCE=https://broker.example
AXXIUM_RELAY_NODE_ID=synthetic-node
AXXIUM_RELAY_NODE_SUBJECT=synthetic-example-only
AXXIUM_RELAY_NODE_SECRET=<its distinct private node secret>
FEDERATION_SELF_CLUSTER_ID=<optional local topology label; default operator-relay>
```

The subject is an operator pin checked against the signed lease, not a request to
choose an owner. Any node setting selects scoped mode and incomplete configuration
refuses startup. Keep secrets in protected process configuration; never commit
real values. In scoped mode no legacy owner, peer DID or broker admin token is
required. The protocol's legacy-named `peerDid` field carries an inert
`operator-node:<node-id>` label; it confers no DID authority. If topology node IDs
are configured, use the granted node ID.

Before every websocket attempt the agent POSTs its own secret to the fixed
HTTPS authority endpoint, refuses redirects, and verifies the returned JWT against
the configured authority's JWKS. A three second authority timeout fails closed.
Only that one-use lease is sent to the broker. `FEDERATION_BRIDGE_AUTH_TOKEN` is
removed from the selected scoped options; issuance failure never falls back to it.
Healthy work stays on the same socket through in-place renewal, including long
streams. The existing reconnect/backoff obtains a fresh lease only after a real
disconnect; interrupted effects are never transparently replayed. Clock
synchronization and normal event-loop progress are operational prerequisites.

Both relay and agent enforce exact RPC paths: `GET /v1/models`, and
`POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings` with an exact granted
model. No query strings, suffix paths, absolute URLs, image operations, background
responses, credential/export/import operations, or generic HTTP tunnel are
allowed. Catalog replies are synthesized from granted exact model names. Scoped
capabilities advertise no prefixes or credential mobility. Request forwarding
keeps only accept/content-type headers, discards remote tenant/routing context,
and passes a close/scope-narrowing/request-cancel signal to the local HTTP execution
adapter. Local provider credentials remain in the local runtime. The pre-existing
local execution adapter trusts its local loopback/internal-header boundary;
protect local process access. No broader local authentication redesign is claimed.

## Server API-key delegation

Knoxx actors use server API keys. An optional broker-only operator setting
`AXXIUM_RELAY_DELEGATIONS` binds an existing SQL key ID and tenant ID to an
**already human-verified** Axxium issuer/subject. The operator populates it only
after actual sign-in; this implementation creates no real identity or approval.
No raw API/provider key belongs in this configuration. Example synthetic entry:

```json
[
  {
    "keyId": "synthetic-existing-sql-key-id",
    "tenantId": "synthetic-broker-local-tenant",
    "issuer": "https://authority.example/oidc",
    "subject": "synthetic-example-only",
    "nodeIds": ["synthetic-node"],
    "models": ["example-model"],
    "operations": ["POST /v1/responses"],
    "expiresAt": 1792800000
  }
]
```

Entries are closed, finite, unique per keyId/tenantId pair and capped at 128.
Node/model/operation scope is explicit and exact; expiry is an integer Unix second.
Operations are only `GET /v1/models`, `POST /v1/chat/completions`,
`POST /v1/responses`, and `POST /v1/embeddings`. Empty lists refuse; no wildcard
semantics exist. The setting is decoded and checked by CLJS for each decision;
changing process environment configuration requires the operator's normal service
configuration lifecycle. No external identity lookup or remote role import occurs.

Delegation is considered only from server-owned `tenant_api_key` authentication
returned by the existing active SQL key lookup **on that request**, with matching
current keyId/tenantId and `proxy:use` scope. The existing tenant/model/provider
policies still run before relay selection. Inactive/missing/revoked SQL keys cannot
reach delegation; no positive authentication cache is added. Revocation is effective
on the next request. A global admin token cannot acquire this identity. Headers,
body, cookies, DIDs, email matches and caller-selected owner metadata cannot provide
or widen it. Browser OIDC users keep their real verified issuer/subject and current
local membership; the delegation list grants them no new rights. Source auth and
provider secrets are stripped before dispatch and never sent to the node.

## Per-RPC dispatch contract

Connection `jti` consumption and RPC consumption are separate. Each scoped
`request_open` has a **closed** `relayBinding` v1 object:

| Field | Exact meaning |
| --- | --- |
| `version` | Integer 1 |
| `nonce` | Server-generated UUID; never caller-selected |
| `method`, `path` | Exact uppercase allowlisted method and exact route above |
| `model` | Exact body model for POST, JSON null for GET |
| `bodyDigest` | Lowercase hex SHA-256 of the complete exact UTF-8 body string |
| `actor` | Canonical qualified verified/delegated owner |
| `tenant` | Current server-resolved broker-local tenant, present in signed scope |
| `node`, `audience`, `issuer` | Exact current lease node/audience/issuer |
| `grantRevision` | Current signed grant revision at dispatch |
| `issuedAt` | Broker integer Unix seconds |
| `expiresAt` | Exactly issuedAt + 120 seconds |

The body is serialized once at the broker. Hash **those bytes**, without parsing,
key sorting, whitespace normalization or JSON reserialization. POST bodies must
parse as JSON objects with an allowed exact `model` and an absent or literal `false` background option; other background values refuse.
GET has no body: hash the empty UTF-8 string and bind model null. Query strings,
fragments, suffix routes, encoded alternate routes and absolute URLs are refused;
there is no query canonicalization or generic tunnel. Content is delivered over
the existing authenticated TLS websocket channel, not via a caller URL.

Before execution the node checks all binding fields against its own current
verified lease and reconstructed complete body, then atomically consumes the nonce
through the **existing production SqlFederationStore boundary**. It uses the
existing `federation_relay_lease_uses` table with a separate RPC namespace containing
issuer/audience/node. Only namespace, nonce and expiry are stored; prompts, media,
API keys and raw bodies never enter the replay table. The stored expiry is
`issuedAt + 120 + 5` seconds, and the existing cleanup retains another 60 seconds.
Future issuance is bounded by 5 seconds; request execution itself must start before
`expiresAt`. No schema migration or alternate store implementation is introduced.

Consumed nonces cannot execute again after reconnect or store reconstruction,
including mutated body/operation attempts. SQL outages fail closed. The node
rechecks current scope, grant revision, expiry and cancellation **after** async SQL
admission, before calling the handler. Renewal may continue already-running work
only while its model/tenant remains authorized. Both endpoints recheck delivery;
close, cancellation, timeout and narrowing abort local work and discard buffered
undelivered output. A late handler/SQL/renewal result cannot revive a canceled
request or a closed session. Finished effects are never automatically replayed.
Native bridges retain their pre-existing separate migration path.

SSE node authentication is deliberately unimplemented. Its hello, event stream,
and message POSTs require a separate multi-request capability binding and replay
contract; reusing a one-use websocket lease across those calls would violate the
current grant. Native SSE remains unchanged. No deploy-time transport decision is
silently made here.

## Verification

Build both owned worktrees first. In the authority checkout:

```sh
npm run test:relay
npm run test:relay-postgres
```

The fixture defaults to sibling `../relay-proxx`; `PROXX_RELAY_WORKTREE` can name
the paired checkout. Default mode uses real production HTTP/JOSE/websocket
adapters with synthetic keys and socket-free Duplex websocket transport. Its SQL
transport double is explicitly **not** PostgreSQL acceptance. `--postgres`
creates an empty owned PostgreSQL cluster under authority `target/`, uses actual
actor reads and the production Proxx replay SQL, tests concurrent lease and RPC consumption, reconstructs stores, checks expiry
cleanup, and uses the production credential SQL lookup for API-key revocation; it never connects to a live
service database. `AXXIUM_TEST_PG_BIN` can select installed PostgreSQL tools.

The socket-free paired fixture now also exercises a 55-second streamed response
with >=5 renewals on one actual ws-codec connection and one handler invocation;
renewal replay/races/binding, wrong tenant, API-key scope negatives, mutated RPC
body/nonce reconstruction, close during async admission, running-work outage,
removal/actor-disable, model/tenant narrowing, cancellation and credential-parser
response/log redaction. Explicit synthetic transport may shorten only renewal
scheduling for adversarial cases; production maximum lease remains fixed at 25s.

The restricted implementer sandbox denies both TCP and Unix listeners. Real
PostgreSQL, network websocket agent reconnects, and complete listener-dependent
suites must run in a permitted parent environment. No runtime acceptance is
asserted by source tests.

### Parent composed-release evidence

The relay source from7360d78/e919a2f is composed with current-release shared
browser renewal/device login, exact-origin write protection, callback credential
redaction and literal/encoded plural enrollment refusal. The final native full
Node suite passes669 tests with two existing skips. CLJS passes159 tests and601
assertions; existing unrelated Redis/Postgres inference warnings remain recorded.
The composed authority's real owned PostgreSQL fixture explicitly selects this
consumer and passes all22 relay adapter groups, including a55-second stream with
continuous lease renewal on one socket. The initial missing-jose test attempt was
stopped; installation from the frozen lockfile preceded the successful full run.

The operator has verified the selected real Axxium actor and provisioned explicit
local Proxx owner memberships through the existing credential store on all three
hosts. This is account preparation, not OIDC activation or a deployed relay.
Native code review, qualified images, host enrollment/cutover and real browser,
Knoxx actor, cross-host streaming and revocation acceptance remain outstanding.
