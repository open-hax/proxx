# Real federation: peer diff sync + AT DID auth

## Status
Active

## Goal
Move `proxx` from the current **shared SQL control-plane shortcut** toward a real peer federation model where multiple proxy instances can:

- register each other over API
- expose auditable federation state over API
- recognize a shared human owner through AT Protocol DIDs
- exchange **slow, lazy diffs** of durable state
- discover remote account availability without immediately copying secrets everywhere
- route requests through a peer when the local node runs out of usable accounts
- promote frequently-used remote accounts from descriptor-only -> routed-through-peer -> fully imported

## User intent this draft must satisfy
The concrete motivating scenario is:

- local development can complete OpenAI/ChatGPT OAuth because the callback is on localhost
- deployed/cloud nodes cannot complete that same browser callback directly
- therefore new OAuth accounts appear first on the local node
- cloud nodes still need to benefit from those accounts without forcing manual export/import
- cloud nodes also accumulate analytics/cost/request usage that should be visible locally

Additionally:

- instances should trust a shared human/operator identity via an **AT DID**
- the old admin key must still work for administrative/bootstrap paths
- a peer auth/key field should accept **either**:
  - the admin key
  - a valid AT DID
- deployments should support cluster/group/node inspection via distinct endpoints

## Why shared SQL is not enough
The current shared-DB approach is acceptable as a narrow control-plane shortcut, especially for homogeneous cloud deployments.

It is not sufficient for the real requirement because:

- local-only OAuth bootstrap creates state asymmetry that should not require one shared DB everywhere
- not all future peers should be tightly coupled to one database
- "same cluster" and "same owner" are distinct concepts
- we need request-time peer discovery/routing before full secret transfer
- we want **slow/lazy projection**, not eager replication of all secrets

## Core model

### 1. Peer identity
Each federated node has:

- a stable **peer DID** (prefer `did:web` for public nodes; local/dev may temporarily use a configured DID until a durable service identity exists)
- one or more **owner subjects**
- control-plane base URL
- data-plane base URL

### 2. Owner identity
A shared human/operator identity is represented by an **AT DID**.

Examples:
- `did:plc:...`
- `did:web:...`

Peers belonging to the same owner can share state under that owner boundary.

### 3. Bootstrap auth compatibility
For peer registration/admin operations, the credential field may be:

- a legacy admin bearer key
- an AT DID

Interpretation:
- if it parses as a valid AT DID, treat it as a DID-rooted owner identity
- otherwise treat it as an admin key/bootstrap secret

This keeps current admin workflows alive while making DID-based federation the canonical long-term identity model.

### 4. Diff-based state sharing
Peers do not full-dump databases to each other on every change.

Instead, each peer exposes an append-only **federation diff stream** of durable state changes, partitioned by owner subject.

Initial state classes to federate:
- OpenAI OAuth/provider credential descriptors
- provider account metadata
- usage/request/cost analytics
- tenant/admin/operator identity relevant to federation

Later state classes may include:
- settings
- quota/budget signals
- revocations

### 5. Lazy account projection
Remote OAuth/provider accounts should not be copied eagerly.

Instead, a receiving peer should move through stages:

1. **descriptor-only**
   - knows account exists on a peer
   - stores non-secret metadata only
   - can consider that peer for request routing

2. **remote-route**
   - if local node needs an account and a peer owned by the same subject has one,
     route that specific request through the peer
   - keep provenance + usage count locally
   - do not import secret yet

3. **warm-import**
   - after repeated successful remote use, import/transfer the account secret or lease into the local node
   - mark provenance so the account remains attributable to its source peer

This matches the user request:
- first use routes through the peer
- repeated use causes full transfer later

## API audit requirements

The federation process must be inspectable through API-only tests.

Minimum required audit surfaces:

1. **Peer registry API**
   - list registered peers
   - create/update peers over API
   - show owner subject, peer DID, URLs, auth mode, status, capabilities

2. **Diff/event API**
   - list owner-scoped federation diff events by cursor/sequence
   - make propagation visible without reading a database directly

3. **Account knowledge API**
   - list accounts with local credentials
   - list accounts known only by remote projection/descriptor
   - clearly distinguish whether the node:
     - has credentials
     - only knows the account exists
     - has warmed the remote account through peer routing (`remote_route`)
     - has fully imported it

This is important because the intended E2E harness will validate behavior through API requests, not browser-driven flows.

## Required behavior

### A. Peer registration over API
Peers must be registerable over API, not only by static file config.

Minimum required fields:
- `peerDid`
- `label`
- `baseUrl` (current data-plane URL)
- `controlBaseUrl` (optional if same as base)
- `dataPlaneBaseUrl` (optional future alias when control-plane and data-plane URLs are fully separated in config/API)
- `ownerCredential` (admin key or AT DID)
- `capabilities` (optional)

### B. Federation auth
Peer requests must support:
- explicit admin bearer auth for bootstrap/repair
- DID-rooted auth for durable trust

Long term:
- DID auth should be backed by DID document resolution + signature verification
- admin key remains a maintenance/bootstrap escape hatch

### C. Diff API
Each peer should expose an owner-scoped diff feed:
- ordered cursor/sequence based
- append-only
- resumable from a last-seen cursor
- intentionally low-frequency / pull-based by default

### D. Remote account discovery
When a node cannot satisfy a request locally, it may ask peers with the same owner subject for candidate accounts.

This lookup should return **descriptors**, not raw secrets.

### E. Peer-routed request execution
If a remote peer has a usable account:
- route the request to that peer
- keep provenance headers / request IDs / hop count
- store a local descriptor and usage evidence
- avoid immediate full credential replication

### F. Warm transfer
If a remote descriptor is used repeatedly and remains healthy:
- import the account secret/credential material
- mark it as imported from peer X under owner Y
- keep source provenance for later reconciliation/revocation

## Slow/lazy sync semantics
This system should optimize for correctness + operability, not aggressive immediacy.

Desired properties:
- pull-based sync is acceptable
- eventual consistency is acceptable
- local reads may be stale for a short window
- account import happens only after evidence of repeated demand
- analytics can arrive later than request completion

Non-goals for the first real-federation milestone:
- eager full-mesh secret replication
- consensus/leader election
- exact-once cross-peer replication
- multi-hop transit beyond one peer hop

## Deployment topology requirement

The deployment should expose three levels of abstraction:

1. **cluster-level endpoint**
   - one load-balanced entrypoint for the entire cluster
2. **group-level endpoints**
   - one load-balanced entrypoint per DB-sharing pair/group
3. **node-level endpoints**
   - one endpoint per individual `proxx` node

Desired concrete shape:
- 4 total nodes
- 2 groups of 2 nodes each
- each group shares one database internally
- the full set federates via peer registration over API

Requested northbound topology:
- nginx in front of the cluster
- nginx in front of each group
- nginx in front of each individual node

That makes it possible to inspect the system at different layers:
- cluster routing behavior
- group-local shared-DB behavior
- exact per-node state

## E2E federation topology

The target E2E environment should create:

- **Group A**
  - `a1`, `a2`
  - share DB A
  - DB A inherits the current environment DB shape/state for migration-oriented coverage

- **Group B**
  - `b1`, `b2`
  - share DB B
  - DB B starts fresh

- all four nodes register/federate through API

The E2E assertions should be API-driven and cover:
- peer registration visibility
- diff/event visibility
- local vs projected account visibility
- peer-routed remote account usage before import
- warm-import transition after repeated usage
- analytics propagation between peers/groups

## Proposed data model

### federation_peers
Stores known peers and trust/bootstrap material.

Suggested fields:
- `id`
- `owner_subject`
- `peer_did`
- `label`
- `base_url`
- `control_base_url`
- `auth_mode` (`admin_key` | `at_did`)
- `auth_json`
- `status`
- `capabilities`
- `last_seen_at`
- timestamps

### federation_diff_events
Append-only owner-scoped change stream.

Suggested fields:
- `seq`
- `owner_subject`
- `entity_type`
- `entity_key`
- `op`
- `payload`
- `created_at`

### federation_peer_sync_state
Tracks pull/push cursors and health per peer.

Suggested fields:
- `peer_id`
- `last_pulled_seq`
- `last_pushed_seq`
- `last_pull_at`
- `last_push_at`
- `last_error`
- `updated_at`

### federation_projected_accounts
Descriptor/provenance cache for remotely-discovered accounts.

Suggested fields:
- `source_peer_id`
- `owner_subject`
- `provider_id`
- `account_id`
- `account_subject`
- `chatgpt_account_id`
- `email`
- `plan_type`
- `availability_state` (`descriptor` | `remote_route` | `imported`)
- `warm_request_count`
- `last_routed_at`
- `imported_at`
- `metadata`
- timestamps

## Routing model

### Phase 1 request-time fallback
When local provider selection yields no usable local account for a model/provider family:

1. restrict candidate peers to the same `owner_subject`
2. query cached projected-account descriptors first
3. optionally refresh descriptors from peers lazily
4. if a peer has a suitable candidate, route the request to that peer
5. record:
   - peer provenance
   - descriptor existence
   - warm-use count

### Phase 2 warm import
When `warm_request_count` crosses a threshold and the peer/account remains healthy:
- request a credential transfer/import from the source peer
- persist locally in the normal account store
- keep provenance link to source peer

Open question:
- should warm import be a full copy or a lease with expiry/refresh back to source?

## AT DID trust model
The DID side should not remain string-only forever.

Minimum intended end state:
- validate peer/human DIDs via DID document resolution
- use DID docs to discover peer/service keys
- use DID-based signatures for peer control-plane requests
- use DID as the durable owner identity boundary for federation sharing

Near-term acceptable bootstrap:
- accept valid DID syntax now
- add DID resolution + proof verification in the next phase

## Open questions
1. What exact data classes belong in the first diff stream?
   - accounts only?
   - analytics only?
   - settings + revocations too?
2. Should remote account execution proxy through the peer’s OpenAI-compatible surface or a dedicated internal route?
3. What is the warm-import threshold?
4. Should imported accounts remain authoritative on the source peer, or become fully local once imported?
5. How should revocation propagate when a source peer revokes an imported account?
6. How much of analytics should be diffed raw vs pre-aggregated?
7. What exact proof binds an AT DID to a peer registration/update request?

## 2026-03-22 local validation milestone

Validated locally in the 4-node federation harness:

- [x] host-routed OpenAI browser OAuth on all four node hosts (`a1`, `a2`, `b1`, `b2`)
- [x] callback URI preservation for host-routed federation domains (no forced localhost:1455 rewrite)
- [x] peer registration + projected descriptor sync from Group A into Group B
- [x] real request-time `/v1/chat/completions` reroute from Group B to Group A when Group B has no local OpenAI accounts
- [x] repeated routed requests trigger warm import into Group B
- [x] post-import requests serve locally from Group B without another federation hop
- [x] usage export/import propagation still works after real routed traffic
- [x] regression fix: key-pool reload now clears stale in-memory accounts when the account store becomes empty

Still pending beyond this local milestone:

- [ ] staging PR and CodeRabbit cleanup
- [ ] staging deploy with federated runtime topology
- [ ] local <-> staging federation validation
- [ ] staging -> main -> prod promotion and equivalent prod validation
- [ ] DID document resolution / proof verification hardening

## Implementation phases

### Phase 1 — schema + core contracts
- add federation tables
- add owner-credential parsing (`admin_key` or AT DID)
- add a federation store module
- draft the diff event shape

### Phase 2 — control-plane API
- peer registration API
- peer listing/status API
- diff export API
- diff pull/import API
- account-knowledge audit API

### Phase 3 — descriptor projection
- emit diff events for account descriptors + analytics
- import peer descriptors into local projection cache
- keep raw secrets local at first

### Phase 4 — peer-routed execution
- when local accounts are exhausted, consult peers with same owner
- route a single request through a peer
- record warm-use evidence locally

### Phase 5 — warm import
- after repeated successful remote use, import the account secret/lease
- mark imported provenance and source peer relationship

### Phase 6 — DID verification hardening
- resolve DID docs
- verify peer signatures / DID-rooted control-plane auth
- keep admin-key bootstrap compatibility

### Phase 7 — deployment + E2E topology
- add 4-node federation docker compose harness
- add nginx cluster/group/node fronts
- add API-only federation propagation tests

## Affected areas
- `src/lib/db/schema.ts`
- new federation store/helpers under `src/lib/`
- request auth / control-plane auth
- provider/account routing fallback
- analytics persistence and projection
- UI/admin APIs for peer registration and status
- future documentation updates in `README.md`

## Definition of done for the first implementation milestone
- federation schema exists
- owner credential can be parsed as admin key or AT DID
- peers can be represented in durable storage
- a durable owner-scoped diff/event model exists in code and schema
- projected remote account descriptors can be represented separately from imported local accounts

## Definition of done for the first operational milestone
- a local node can register an OAuth account
- a cloud peer can discover that descriptor under the same owner subject
- when local/cloud lacks a usable local account, it can route a request through the owning peer
- repeated use can promote that account toward full local import
- analytics/request evidence diff back lazily between peers
