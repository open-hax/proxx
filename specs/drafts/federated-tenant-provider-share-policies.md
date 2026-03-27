# Federated tenant-provider share policies + owned-fleet public relay demo

## Status
Active

## Summary
Define the first end-to-end demonstration architecture where `proxx` acts as a **multi-tenant federation fabric** across a fleet of machines owned by one operator, with `big.ussy.promethean.rest` serving as the stable public relay.

This draft adds the missing policy layer between:
- tenant identity
- peer identity
- provider/resource ownership
- federation routing and credential movement

It is a focused companion to:
- `specs/drafts/open-hax-openai-proxy-multitenancy-user-model.md`
- `specs/drafts/real-federation-peer-diff-and-at-did-auth.md`
- `specs/drafts/federation-bridge-ws-v0.md`
- `specs/drafts/tenant-federation-cloud-roadmap.md`

## Why this draft exists
Current drafts already cover:
- tenant identity and tenant-scoped auth
- peer registration, projected accounts, warm import, and bridge relay transport
- cloud/deployment constraints

What is still missing is the explicit answer to:

> given a tenant DID and a provider resource anywhere in the fleet, what is allowed to happen?

That policy question decides whether a remote peer may:
- see only a descriptor
- route through the source peer as a relay
- warm-import after repeated successful use
- receive projected credentials over an encrypted channel

Without this layer, owned-fleet demos and future less-trusted federation both remain ambiguous.

## Demo target
The immediate demonstration target is:

- local cluster remains the localhost/OAuth bootstrap enclave
- `big.ussy.promethean.rest` becomes the stable public relay / public edge
- other owned/administered peers such as hive mind, big bussy, and voxx join as registered peers
- each peer is modeled both as:
  - a tenant/principal that can consume federated resources
  - a provider surface that can expose federated resources

This produces a real demo where:
- local-only credentials can be used remotely
- the public relay can route requests across owned peers
- policy is explicit about what can be relayed vs imported vs projected

## Goals
1. Make `big ussy` the stable public relay for the first real multi-machine demo.
2. Treat peer/workspace identities as tenant-like principals keyed by DIDs.
3. Treat local upstream accounts and remote `proxx` peers uniformly enough that both can participate in provider selection.
4. Add an explicit sharing-policy layer that constrains federation before routing logic runs.
5. Support a trusted owned-fleet phase where encrypted credential projection/import is allowed when policy says so.
6. Preserve a safer relay-only phase for less-trusted peers after the owned-fleet demo succeeds.

## Non-goals
- Replacing existing tenant auth/session work.
- Solving all delegated capability / PoP details here; those stay with the canonical user-model draft.
- Requiring Kubernetes for the first public-relay demo.
- Forcing per-target deploy branches into every child repository.
- Automatically projecting credentials to every same-owner peer.

## Core model

### 1. Owner root
The highest trust boundary remains an operator-owned subject, typically an AT DID or equivalent durable owner identity.

This is the root that answers:
- which peers are considered administratively owned together
- which peers are allowed to receive projected credentials at all

### 2. Tenant DID
A tenant in the federated sense is a principal that may consume resources.

For the first demo, the simplest representation is a DID-like subject per peer/workspace, for example:
- `did:web:local.promethean.rest`
- `did:web:big.ussy.promethean.rest`
- `did:web:hive-mind.promethean.rest`
- `did:web:voxx.promethean.rest`

This tenant DID is not the same thing as the owner root. Multiple tenant DIDs may share one owner root.

### 3. Provider resource
A provider resource is anything the router may spend or route through, such as:
- a local upstream account pool (`openai`, `factory`, `requesty`, etc.)
- a specific account descriptor within that pool
- a remote `proxx` peer exposed as a provider surface

For policy purposes, the important point is:
- a peer can be both a tenant/principal and a provider/resource owner

### 4. Share mode
Each tenant DID x provider relationship must declare a share mode.

Recommended initial enum:
- `deny`
  - no descriptor visibility, no relay, no import, no projection
- `descriptor_only`
  - tenant may learn that a resource exists and may use it for planning/visibility, but not route through it yet
- `relay_only`
  - requests may be forwarded through the source peer, but credentials never leave the source
- `warm_import`
  - starts as relay-only, then allows import after threshold + health checks
- `project_credentials`
  - encrypted credential projection to the target peer is allowed by explicit policy

Default should be `deny`, with `relay_only` as the safest common explicit allow mode.

### 5. Trust tier
The system should distinguish at least two trust tiers:

- `owned_administered`
  - peers controlled by the same operator/root trust boundary
  - may be eligible for `warm_import` or `project_credentials`
- `less_trusted`
  - external or partially trusted peers
  - default max mode is `relay_only`

### 6. Tenant-provider policy object
Introduce a durable policy object, conceptually `tenant_provider_policies`, keyed by:
- `subjectDid`
- `providerId`

Suggested fields:
- `subjectDid`
- `providerId`
- `providerKind` (`local_upstream` | `peer_proxx`)
- `ownerSubject`
- `shareMode`
- `allowedModels`
- `allowedAccountIds` or `accountSelectionPolicy`
- `maxRequestsPerMinute`
- `maxConcurrentRequests`
- `encryptedChannelRequired`
- `warmImportThreshold`
- `notes`
- `createdAt`, `updatedAt`

This is the first object the routing layer should consult after auth resolves the tenant DID.

## Policy evaluation order
The hot-path order should be explicit:

1. resolve caller auth -> tenant DID / tenant identity
2. enumerate candidate providers/resources
3. filter candidates through tenant-provider sharing policy
4. only then let routing strategy rank/select among the allowed candidates
5. when a remote candidate is selected, apply share-mode rules:
   - `descriptor_only` -> not executable
   - `relay_only` -> remote forwarding only
   - `warm_import` -> remote forwarding first, import later if threshold reached
   - `project_credentials` -> explicit encrypted credential projection/import allowed

This keeps routing policy subordinate to sharing policy.

## UI implications
The console needs a dedicated sharing-policy surface, not only tenant/session management.

Recommended first UI panel shape:
- tenant/principal selector (subject DID)
- provider selector
- share mode selector
- optional model allowlist
- optional account/pool restrictions
- optional import threshold
- optional encrypted-channel requirement toggle

This panel should answer, visibly and operationally:
- which tenants can use which providers
- whether use is relay-only or projection-capable
- what limits apply

## Deployment implications for the demo
`big ussy` should be treated as the stable public relay node for the first demonstration.

That means the deployment contract for `big ussy` must be explicit about:
- target runtime path
- whether it replaces the current proxx-like runtime or runs side-by-side
- edge ownership (`host-caddy` vs `container-caddy`)
- compose project name and compose file set
- required external Docker networks
- runtime files (`.env`, `keys.json`, `models.json`)
- intended public hostnames

This strongly suggests a target-manifest pattern at the superproject layer rather than host-specific branches in every submodule.

## Recommended Git/promotion model
For this architecture, separate:

- **code promotion**
  - feature -> `staging` -> `main`
- **environment/target promotion**
  - target manifests or env branches in the superproject that pin child SHAs and deployment assumptions

Avoid per-target branches inside each submodule unless the code genuinely diverges.

## Phase plan

### Phase 1 — owned-fleet public relay demo
- make `big ussy` a stable public relay
- register local cluster + owned peers
- add tenant-provider policy storage and UI/API
- allow explicit `warm_import` / `project_credentials` for owned peers over encrypted channels
- prove local OAuth bootstrap can safely feed the public relay through owned peers

### Phase 2 — policy-enforced mixed sharing
- keep owned peers on privileged share modes where desired
- add less-trusted peers with `relay_only`
- prove that routing works while credential projection remains forbidden

### Phase 3 — capability hardening
- align delegated capabilities / PoP / DID verification with the canonical user-model draft
- require stronger proof for higher-risk share modes

## MVP decisions
1. Tenant DIDs map **1:1 to peer DIDs** for the first demo.
   - simplest because a registered peer is both the consuming principal and the provider surface identity
   - multiple logical tenant DIDs per peer can come later if needed
2. `project_credentials` is a **strict superset** of `warm_import` for MVP.
   - if projection is allowed, warm import is implicitly allowed
   - keep both labels because operators still need to distinguish relay-first import from explicit projection capability
3. The first provider-policy object is attached at **provider-pool level only**.
   - account-level grants are deferred
   - `providerId` is the MVP attachment key, with account-level refinement later if needed
4. `project_credentials` requires only an **explicit allow policy plus an authenticated encrypted channel between same-owner peers** for MVP.
   - accepted channel shapes for MVP: authenticated bridge relay session or authenticated peer HTTPS control/data-plane session over TLS
   - no extra PoP or delegated capability proof is required for the first owned-fleet demo
5. The UI should surface **owner root as read-only context** and **tenant DID as the editable policy subject**.
   - simplest panel shape: owner root header, then policy rows keyed by subject DID and providerId
   - this keeps trust-root and tenant-principal visible without forcing a second editing surface yet

## Definition of done for the first demo
- `big ussy` is the public relay and has a stable deployment contract.
- local cluster can bootstrap OAuth credentials and expose them through the relay fabric.
- owned peers can be registered as both tenants and provider surfaces.
- tenant-provider sharing policy exists in durable storage and is visible/editable through the UI or API.
- at least one owned peer can use `warm_import` or `project_credentials` successfully.
- at least one less-trusted peer or simulated trust tier can be constrained to `relay_only`.
- routing decisions operate only on provider resources allowed by sharing policy.
