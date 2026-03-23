# Federation bridge over outbound WebSockets v0

## Status
Draft

## Summary
Add a **relay-mediated federation bridge** that lets a local `proxx` cluster with localhost-only OAuth bootstrap lend capability to a cloud/staging `proxx` cluster without requiring inbound connectivity to the local machine and without immediately copying raw OAuth secrets into the cloud.

This draft is a companion to:
- `specs/drafts/real-federation-peer-diff-and-at-did-auth.md`
- `specs/drafts/proxy-federation.md`
- `specs/drafts/open-hax-openai-proxy-multitenancy-user-model.md`

It narrows the current practical problem:
- OpenAI / Codex / ChatGPT browser OAuth may require a callback on `localhost`
- the cloud/staging cluster cannot complete that flow directly
- valid accounts therefore appear first on the local cluster
- the cloud/staging cluster still needs to route requests through those accounts
- the local machine sits behind NAT / unchangeable network rules, so the local side must initiate the connection first

The proposed answer is an outbound-initiated **WebSocket bridge** from local to staging.

## User intent this draft must satisfy
The motivating operator workflow is:

- run a local cluster and a cloud/staging cluster with the same internal topology
- complete browser/OAuth login on the local cluster where `localhost` callbacks are possible
- make those locally-held accounts useful to the staging cluster without manual credential export
- let the staging cluster remain the public edge
- keep local-to-cloud communication possible even when the cloud cannot dial into the local network
- make the connection, health, capability, and routing state visible over API

The operator specifically prefers:
- an outbound-initiated transport
- persistent connectivity
- a design that resembles STUN/TURN in spirit, but does not require true hole-punching or direct peer-to-peer ingress
- WebSockets as the initial transport

## Why a bridge is needed
The current real-federation work already covers:
- peer registration over API
- auditable peer/diff/account state over API
- projected-account lifecycle (`descriptor` -> `remote_route` -> `imported`)
- peer-routed request execution between reachable peers
- 4-node federation topology with cluster/group/node routing

That is not enough for the localhost-only OAuth constraint.

The missing piece is:
- a cloud peer cannot reach a NAT-bound local peer unless the local peer creates and maintains an outbound path first

Therefore, the system needs a transport layer that:
- is initiated by the local side
- stays up long enough to carry health, capability, and request streams
- can be audited and routed through explicitly
- does not require firewall/NAT changes on the local side

## Design stance
This is **not** full generic peer-to-peer NAT traversal in v0.

It is a **public relay model**:
- local cluster opens a persistent outbound connection to a public staging relay endpoint
- staging treats that relay connection as an attached remote execution capability
- staging may route eligible requests across that relay when local cloud accounts are unavailable or policy prefers the bridge

The closest analogy is:
- **TURN-like relay** rather than ICE/STUN-style direct peer connectivity

## Core terms

### Edge cluster
The public cloud/staging cluster.

Responsibilities:
- public ingress
- relay endpoint hosting
- stable control-plane registry
- cloud-visible audit APIs
- optional local cloud account execution
- routing into the bridge when appropriate

### Enclave cluster
The local/private cluster that can complete browser/OAuth login and holds localhost-bootstrapped credentials.

Responsibilities:
- initiate outbound bridge connections
- advertise health and capabilities
- optionally execute remote-routed requests on behalf of the edge cluster
- keep sensitive OAuth/browser-derived credentials local by default

### Bridge relay
The public WebSocket endpoint hosted by the edge cluster.

Responsibilities:
- authenticate bridge sessions
- bind them to peer / cluster-agent identity plus advertised topology
- multiplex health/capability and request/response streams
- expose audit state over HTTP APIs

### Bridge agent
A cluster-scoped process that owns one outbound bridge session for the enclave cluster in v0.

Responsibilities:
- authenticate as the enclave cluster's relay representative
- aggregate or proxy node/group capability state into one session
- open and maintain the outbound connection to the edge cluster
- fan routed requests inward to the appropriate local node when needed

### Bridge session
A long-lived authenticated connection from one enclave **cluster agent** to the edge cluster.

### Bridge-routed account
An account whose credentials remain local but whose request-serving capability is exposed to the edge cluster via the bridge.

### Capability advertisement
Structured metadata sent over the bridge describing what a connected enclave peer can do, without sending raw secrets.

## Goals
1. Allow a NAT-bound local cluster to connect to staging via outbound-only transport.
2. Make local-only OAuth accounts visible as routable capability in staging.
3. Keep raw OAuth secrets local by default.
4. Expose bridge liveness, identity, and capability state over API.
5. Support request execution over the bridge for key public API paths.
6. Preserve provenance, hop count, auditability, and operator trust boundaries.
7. Fit the existing cluster/group/node topology model.
8. Distinguish cloud-self health from bridge-assisted capability clearly in CI and ops.

## Non-goals (v0)
- Full ICE/STUN direct peer NAT traversal.
- Arbitrary mesh connectivity between every pair of clusters.
- Multi-hop bridge routing.
- Generic VPN replacement.
- Eager replication of raw browser/OAuth secrets into staging.
- Making bridge-dependent checks silently pass when the bridge is absent.
- Replacing the existing HTTP federation APIs for peer registry, diff feeds, or audit surfaces.

## Topology model

### Required cluster symmetry
The local and staging clusters should support the same conceptual topology:
- cluster-level endpoint
- group-level endpoints
- node-level endpoints
- two groups of two nodes each

For example:
- Group A: `a1`, `a2`
- Group B: `b1`, `b2`

This does **not** require equal public reachability.

The practical expectation is:
- staging exposes public cluster/group/node inspection endpoints
- local may expose the same shape only to itself or to the relay path
- bridge advertisements should still identify cluster/group/node origin explicitly so staging can reason about locality and topology

### Public/default traffic policy
For production-like public traffic, the edge cluster remains authoritative unless policy explicitly selects the bridge.

This draft does **not** require that the public edge cluster spray ordinary public traffic across both cloud and local clusters indiscriminately.

Instead, the bridge should be used only when one of the following is true:
- a request explicitly targets a bridge-routed account or owner subject
- the local cloud cluster lacks a usable matching account
- routing policy marks a bridge capability as preferred for that model/provider
- an operator/debug flow explicitly asks to inspect the enclave side

## Layered protocol model

### Layer 0 — Identity and trust
Before a bridge session is accepted, the edge cluster must bind the connection to a durable identity.

Minimum identity dimensions:
- `ownerSubject`
- `peerDid`
- `clusterId`
- `agentId`
- `environment` (`local`, `staging`, `production`, etc.)

In v0, bridge session granularity is **per cluster agent**.

That means:
- `groupId` and `nodeId` are not the primary socket identity
- group/node topology is advertised inside capability and health payloads
- routed requests still record exact `servedByGroupId` / `servedByNodeId` provenance when execution lands on a specific node

Allowed trust roots:
- existing admin/bootstrap secret
- DID-rooted owner identity as defined in the federation draft

Desired direction:
- bridge auth should move toward DID-signed challenge/response
- admin secret remains an escape hatch for bootstrap and repair

### Layer 1 — Health and capability relay
This is the first required milestone.

The bridge must carry:
- presence
- session liveness
- capability advertisement
- local health
- account/provider/model availability summaries

This layer alone should let staging answer:
- is the local cluster connected?
- which advertised local nodes are currently reachable behind the cluster agent?
- which providers/models are bridge-routable?
- are those routes healthy or degraded?
- which accounts are local-only vs importable vs directly cloud-available?

### Layer 2 — Request execution relay
After Layer 1 is stable, the bridge carries selected request/response streams for:
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- optional narrow admin/audit APIs needed for federation execution

### Layer 3 — Optional sync/usage augmentation
Later, the bridge may also carry:
- usage receipts
- local health deltas
- route learning hints
- short-lived lease/lock signals

This layer is optional in v0 because existing HTTP federation control-plane APIs already cover much of the durable state exchange.

## Outbound connection model

### Initiation
The enclave/local side must initiate the connection.

Proposed endpoint shape:
- `wss://<edge-host>/api/ui/federation/bridge/ws`

The edge cluster never needs to open an inbound connection to the local cluster.

### Environment relay boundaries
Each environment hosts its own relay and trust boundary.

That means:
- staging bridge sessions connect to the staging relay endpoint
- production bridge sessions connect to the production relay endpoint
- a bridge session is never implicitly shared across staging and production

### Session lifecycle
1. local cluster agent acquires or derives bridge auth material
2. local cluster agent opens WSS connection to staging
3. local cluster agent sends `hello`
4. staging validates identity and replies `hello_ack`
5. local cluster agent begins heartbeats + capability advertisements
6. staging may route eligible requests over the session
7. on disconnect, staging marks bridge capability unavailable and stops routing through it

### Reconnect behavior
The local side should reconnect automatically with backoff.

Requirements:
- exponential backoff with jitter
- bounded retry delay
- explicit session expiration on the edge side
- last-seen timestamps visible over API

## Frame envelope v0
v0 uses JSON text frames first for simplicity, debuggability, and easy operator inspection.

Binary optimization is explicitly deferred to a later revision.

### Common envelope
Every frame should include:
- `type`
- `protocolVersion`
- `sessionId` (after `hello_ack`)
- `streamId` (for request/response streams when applicable)
- `sentAt`
- `traceId`
- `ownerSubject`
- `clusterId`
- `agentId`

Frames may additionally include `groupId` and `nodeId` when a message refers to a specific advertised topology element or execution target.

### Required frame types

#### `hello`
Sent by enclave on connect.

Fields:
- `peerDid`
- `ownerSubject`
- `clusterId`
- `agentId`
- `environment`
- `bridgeAgentVersion`
- `authMode`
- `capabilitiesHash`
- `labels` / human-readable metadata
- optional topology summary (`groups`, `nodes`, `defaultExecutionPolicy`)

#### `hello_ack`
Sent by edge after validation.

Fields:
- `sessionId`
- `heartbeatIntervalMs`
- `maxConcurrentStreams`
- `maxFrameBytes`
- optional `resumeToken` (future)

#### `heartbeat`
Periodic liveness frame.

Fields:
- `sequence`
- optional rolling counters (`activeStreams`, `queuedRequests`)

#### `capabilities`
Advertisement of bridge-routable capability.

Fields should include:
- provider IDs
- model IDs and/or prefixes
- account descriptors (non-secret)
- execution modes supported (`models`, `chat_completions`, `responses`)
- whether capability is:
  - `cloud_local`
  - `peer_http`
  - `bridge_ws`
- whether credentials are:
  - `local_only`
  - `descriptor_only`
  - `importable`
  - `non_exportable`
- last successful upstream timestamps
- account availability counts
- current health state / cooldown state / quota hints

#### `health_report`
Cluster-agent summary with optional per-group/per-node health detail.

Fields:
- process health
- upstream health
- account availability counts
- last error classes
- local request backlog
- local OAuth/bootstrap readiness

#### `request_open`
Start a bridged request.

Fields:
- `streamId`
- `method`
- `path`
- sanitized headers
- request context metadata
- routing intent (`providerId`, `model`, optional `accountId`)
- provenance (`originClusterId`, `originNodeId`, `hopCount`)

#### `request_chunk`
A chunk of request body data.

Fields:
- `streamId`
- `chunk`
- `encoding` (`utf8`, `base64`)
- `final` flag optional

#### `response_head`
Response status + headers.

Fields:
- `streamId`
- `status`
- response headers
- provenance summary (`servedByCluster`, `servedByGroup`, `servedByNode`, `providerId`, `accountId` if policy permits)

#### `response_chunk`
Chunk of response body data.

#### `response_end`
End-of-stream signal.

Fields:
- `streamId`
- usage summary if already known
- final provenance info

#### `error`
Protocol or stream error.

Fields:
- `streamId` optional
- `code`
- `message`
- `retryable`

## Request routing semantics

### Routing priority
Default public routing order should be explicit.

Proposed order:
1. cloud-local account on the edge cluster
2. cloud peer reachable by existing federation HTTP path
3. enclave bridge-routed account via WebSocket bridge
4. explicit no-available-route failure

This keeps the public edge stable while still enabling local-only OAuth accounts to participate.

### Explicit bridge eligibility
Not every request should be bridge-eligible.

A request may use the bridge only when:
- the model/provider is advertised by a live bridge capability
- trust boundary permits the owner subject / tenant to traverse the bridge
- hop count remains within policy
- request size / stream duration stays within policy

### Failure semantics
If a bridged route is selected and fails, the system must return an explicit error class rather than hanging.

Minimum error classes:
- `bridge_unavailable`
- `bridge_capability_missing`
- `bridge_stream_timeout`
- `bridge_auth_failed`
- `bridge_remote_no_available_key`

These should be visible in request logs and, where possible, surfaced in the API response in a stable form.

## Capability advertisement model
The edge cluster needs more than just “peer is connected”.

Each bridge capability advertisement should declare at least:
- `providerId`
- `modelPrefixes` and/or concrete models
- `authType`
- `accountCount`
- `availableAccountCount`
- `supportsModelsList`
- `supportsChatCompletions`
- `supportsResponses`
- `supportsStreaming`
- `supportsWarmImport`
- `credentialMobility` (`non_exportable`, `descriptor_only`, `importable`)
- `credentialOrigin` (`localhost_oauth`, `cloud_api_key`, `imported_peer`, etc.)
- `lastHealthyAt`
- `lastFailureAt`
- `failureClass`

This is required so staging can distinguish:
- cloud-held direct capability
- remote peer HTTP capability
- enclave-only bridge capability

## Models surface semantics
`GET /v1/models` should do both of the following in v0:
- merge cloud-local and bridge-advertised model inventory for the operator-facing/root models surface
- preserve enough provenance in audit APIs to separate which models came from cloud-local capability versus bridge capability

This keeps the public API useful while avoiding the loss of source-of-truth visibility.

## Audit/API surfaces
This draft adds new required audit surfaces.

### `GET /api/ui/federation/bridges`
List active and recent bridge sessions.

Each row should show:
- session identity
- owner subject
- peer DID
- cluster/agent identity
- advertised group/node inventory
- environment
- connected/disconnected state
- last seen time
- heartbeat RTT estimate if available
- capability summary

### `GET /api/ui/federation/bridges/:sessionId`
Detailed bridge session view.

Should include:
- capability payload
- health payload
- recent routed request counts
- recent failure classes

### `GET /api/ui/federation/bridge-routes`
Show bridge-advertised routes as candidates in the same operator surface used for peer-routed federation.

### Existing request/usage APIs
Request and usage surfaces should mark when a request was served by:
- local cloud account
- peer HTTP route
- enclave bridge route

Minimum provenance markers:
- `routeKind`
- `servedByClusterId`
- `servedByGroupId`
- `servedByNodeId`
- `bridgeSessionId` when applicable

## Security requirements
1. Bridge sessions must be authenticated before requests are accepted.
2. Bridge auth must bind to owner subject and peer identity, not just an anonymous bearer.
3. Routed requests must carry hop count and trace IDs.
4. The edge cluster must enforce allowlists for which tenants/owners/models may use the bridge.
5. Raw OAuth secrets must not be sent in bridge capability frames.
6. Frame sizes, stream counts, and idle times must be bounded.
7. The bridge relay must not become an open generic proxy.

## CI and operational contract
This draft changes how staging health should be reasoned about.

### Separate check classes
The system should distinguish:

#### Cloud-self checks
These verify the public cloud cluster can:
- boot
- serve health
- serve models from cloud-held capability
- run non-bridge-required flows

#### Bridge-assisted checks
These verify that:
- local enclave bridge sessions are connected
- local-only OAuth capabilities are visible from staging
- bridge-routed requests can succeed

If the local bridge is not always-on infrastructure, bridge-assisted checks should not pretend to be cloud-self checks.

### Honest failure reporting
If a cloud check fails because the bridge is absent or degraded, the error should say so directly instead of showing only a generic “no response” symptom.

## Implementation phases

### Phase 1 — Spec + data model
- add this draft
- define bridge session and capability schemas
- add API shapes for bridge audit surfaces

### Phase 2 — Layer 1 health bridge
- add edge relay WebSocket endpoint
- add enclave bridge agent/client
- implement `hello`, `hello_ack`, `heartbeat`, `capabilities`, `health_report`
- make one session represent one enclave cluster agent, not one node
- expose live bridge sessions via API

### Phase 3 — Models capability over bridge
- make staging able to surface bridge-advertised model inventory
- merge bridge-advertised inventory into the root `/v1/models` view while keeping source provenance inspectable in audit APIs
- verify that locally-bootstrapped accounts become visible as routable capability without secret import

### Phase 4 — Request execution over bridge
- support bridged `chat/completions` and `responses`
- preserve provenance and request logs
- make failures explicit and auditable

### Phase 5 — Policy + CI split
- separate cloud-self vs bridge-assisted checks
- make staging/operator dashboards show bridge liveness and capability clearly

### Phase 6 — Optional warm-import integration
- connect bridge-routed execution to the projected-account lifecycle
- allow repeated bridge use to trigger controlled warm import when policy allows
- keep warm-import policy outside the transport layer itself; the bridge carries capability and execution, while import decisions remain a higher-layer policy concern

## Verification plan
1. Start a local cluster behind NAT with no inbound firewall changes.
2. Open bridge sessions from local to staging.
3. Verify `GET /api/ui/federation/bridges` shows the connected local cluster agent plus its advertised node inventory.
4. Verify staging can see bridge-advertised model inventory from local-held OAuth accounts.
5. Verify an edge request can route to a bridge-held account and complete.
6. Verify request logs show bridge provenance.
7. Disconnect the local bridge and verify staging returns explicit bridge error classes rather than hanging.
8. Verify public/default cloud traffic still behaves deterministically when bridge capability is absent.

## Risks
- A long-lived bridge makes the local machine operationally significant for staging.
- Generic streaming over WS can become opaque if provenance/error classes are weak.
- If bridge policy is too loose, the edge cluster may overuse enclave accounts or bypass intended trust boundaries.
- If bridge-dependent checks are marked as required without treating the local bridge as real infrastructure, CI will become misleading.

## Accepted v0 decisions
1. Request streaming uses pure JSON frames first.
2. `GET /v1/models` merges cloud-local and bridge-advertised inventory while audit APIs keep the sources separable.
3. Warm-import policy stays outside the transport layer; the bridge exposes capability and execution, but import decisions are higher-layer policy.
4. Staging and production use separate relay endpoints and separate trust boundaries.

## Affected areas
- `src/app.ts`
- `src/lib/ui-routes.ts`
- `src/lib/federation/*`
- `src/lib/request-log-store.ts`
- `src/lib/provider-strategy/*`
- staging/production deploy workflows
- federation runtime topology config
- new bridge agent/client runtime module(s)

## Definition of done
- A local cluster behind NAT can establish an outbound-authenticated **cluster-agent** bridge session to staging.
- Staging exposes bridge session health/capability state over API, including advertised node/group inventory behind that cluster agent.
- Staging can identify locally-held OAuth capability without importing raw secrets.
- At least `models`, `chat/completions`, and `responses` can be bridged for eligible accounts.
- Bridge failures are explicit, auditable, and distinct from generic upstream failures.
- Cloud-self health remains distinguishable from bridge-assisted capability.
