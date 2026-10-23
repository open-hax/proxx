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
and node, bounded unique exact model names, `jti`, grant revision, integer times,
positive lifetime <=25 seconds, and at most one second future issuance skew.
Expiration has no grace period. Invalid leases never acquire native privileges.

The CLJS runtime and PostgreSQL federation store are mandatory when configured.
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
window after authority-side grant revocation/actor disable. The implementation
does not extend connections through an issuance outage or renew them in place.

Verified browser users route by the same qualified issuer/subject. For scoped
node sessions, route selection requires the matching verified OIDC identity and
an admitted local tenant. A legacy admin's owner override cannot impersonate that
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
The existing reconnect/backoff mechanism obtains a fresh lease after expiry.
Long inference is interrupted at expiry and is not silently replayed. Clock
synchronization and normal event-loop progress are operational prerequisites.

Both relay and agent enforce exact RPC paths: `GET /v1/models`, and
`POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings` with an exact granted
model. No query strings, suffix paths, absolute URLs, image operations, background
responses, credential/export/import operations, or generic HTTP tunnel are
allowed. Catalog replies are synthesized from granted exact model names. Scoped
capabilities advertise no prefixes or credential mobility. Request forwarding
keeps only accept/content-type headers, discards remote tenant/routing context,
and passes a websocket-close cancellation signal to the local HTTP execution
adapter. Local provider credentials remain in the local runtime. The pre-existing
local execution adapter trusts its local loopback/internal-header boundary;
protect local process access. No broader local authentication redesign is claimed.

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
actor reads and the production Proxx replay SQL, tests concurrent consumption,
reconnects the pool/store, and checks expiry cleanup; it never connects to a live
service database. `AXXIUM_TEST_PG_BIN` can select installed PostgreSQL tools.

The restricted implementer sandbox denies both TCP and Unix listeners. Real
PostgreSQL, network websocket agent reconnects, and complete listener-dependent
suites must run in a permitted parent environment. No runtime acceptance is
asserted by source tests.
