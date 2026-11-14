# Proxx operator reference

Operator material moved out of `AGENTS.md`: federation modes, health and
federation-status checks, the OpenAPI contract, release steps and
troubleshooting. Agent rules stay in `AGENTS.md`. Production is owned by
`open-hax/services` (see `docs/deployment-ownership.md`); this repository
declares no testing or staging environment.

Defaults below: API on `8789`, web console on `5174`.

## Federation modes

### Mode A: isolated local

No federation config is needed. Set `PROXY_AUTH_TOKEN` and run.

```bash
cp examples/.env.example .env
# Edit: PROXY_AUTH_TOKEN=your-secret
pnpm dev
```

### Mode B: multi-tenant local

Set `DATABASE_URL` to PostgreSQL. Tenants are isolated by API key.

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/proxx pnpm dev

# Tenants visible to the caller
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" http://127.0.0.1:8789/api/v1/tenants

# Issue a tenant-scoped API key
curl -X POST http://127.0.0.1:8789/api/v1/tenants/<tenantId>/api-keys \
  -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "team-alpha", "scopes": ["proxy:use"]}'
```

### Mode C: federated cloud

1. Host placement and deployment go through `open-hax/services`.
2. Point instances at the same `DATABASE_URL` only when that database excludes
   credential-bearing tables and secrets. Keep OAuth refresh tokens local to the
   instance that owns them; share access through peer projection or the bridge.
3. Set each instance's identity:
   ```bash
   FEDERATION_SELF_CLUSTER_ID=production
   FEDERATION_SELF_GROUP_ID=group-a
   FEDERATION_SELF_NODE_ID=a1
   ```
4. Register peers with `POST /api/v1/federation/peers`; list them with `GET`.
5. Topology targeting uses the execution policies `cluster_default`,
   `group_affinity` and `node_affinity` (`proxx.federation.protocol`). A bridge
   agent's default comes from `FEDERATION_BRIDGE_DEFAULT_EXECUTION_POLICY`.

Projected-account admission and order are declared in
`resources/policies/runtime/65-federation-routing.edn`.

### Mode D: WebSocket bridge

Connect a local instance to a cloud instance without inbound ports.

Local side (`proxx.federation.autostart/resolve-options`):

```bash
FEDERATION_BRIDGE_RELAY_URL=wss://<cloud-host>/api/ui/federation/bridge/ws
FEDERATION_BRIDGE_AUTH_TOKEN=<bridge-token>      # sent as "Bearer <token>"
FEDERATION_BRIDGE_AUTH_MODE=admin_key            # or at_did, did_signed_challenge
FEDERATION_BRIDGE_OWNER_SUBJECT=<owner>          # or FEDERATION_DEFAULT_OWNER_SUBJECT
FEDERATION_BRIDGE_AGENT_ID=<agent-id>
FEDERATION_SELF_PEER_DID=<did>
FEDERATION_SELF_CLUSTER_ID=local
FEDERATION_SELF_GROUP_ID=enclave
FEDERATION_SELF_NODE_ID=local-node
```

The bridge agent starts when `FEDERATION_BRIDGE_RELAY_URL` is set and the owner
subject, peer DID, cluster ID and agent ID are present; otherwise it is skipped
and the missing variables are reported. It opens an outbound WebSocket,
advertises local capabilities (models, providers), routes cloud requests to
local accounts and reconnects with backoff
(`FEDERATION_BRIDGE_RECONNECT_MIN_MS` / `FEDERATION_BRIDGE_RECONNECT_MAX_MS`).

Cloud side: the relay is served at `/api/ui/federation/bridge/ws`. List
sessions with `GET /api/v1/federation/bridges`; inspect one with
`GET /api/v1/federation/bridges/{sessionId}`.

Protocol: `kanban/drafts/federation-bridge-ws-v0.md`.

## Health checks

```bash
# Local
curl http://127.0.0.1:8789/health | jq '.'

# Production (Services-owned runtime)
curl https://proxx.promethean.rest/health | jq '.'
```

Use the local check while developing. Services owns the sole production runtime
and its live verification.

### Federation status

```bash
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  https://proxx.promethean.rest/api/v1/federation/bridges | jq '.'
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  https://proxx.promethean.rest/api/v1/federation/peers | jq '.'
```

## OpenAPI contract

```bash
curl https://proxx.promethean.rest/api/v1/openapi.json > openapi.json
npx @apidevtools/swagger-cli validate openapi.json
jq '.paths | keys[]' openapi.json
```

The contract is generated from the Fastify route schemas by `@fastify/swagger`
(`proxx.app.main`); Swagger UI is served at `/docs`.

## Versioning and release

| Change type | Bump |
|-------------|------|
| Breaking API change | MAJOR (X.0.0); document the breaking changes |
| New feature/endpoint | MINOR (0.Y.0) |
| Bug fix/improvement | PATCH (0.0.Z) |

1. In a PR against `main`, update `version` in `package.json` and the
   "Version History" table in `README.md`.
2. On merge, `.github/workflows/release-on-merge.yml` runs eta-mu's
   `release-and-publish` workflow with tag prefix `v`, `create-release: true`
   and `publish-npm: false`.

Open question: the previous `AGENTS.md` also pushed a release commit and tag
straight to `main` and ran `npm publish --access public` with `NPM_TOKEN`. That
conflicts with the single-trunk PR policy and with `publish-npm: false`, so it
is not reproduced here until the maintainer decides whether npm publishing
belongs in the workflow.

## Troubleshooting

### Bridge not connecting

1. Check the relay URL: `FEDERATION_BRIDGE_RELAY_URL=wss://…/api/ui/federation/bridge/ws`.
2. Check the token: `FEDERATION_BRIDGE_AUTH_TOKEN` and `FEDERATION_BRIDGE_AUTH_MODE`.
3. Check the startup log for a skipped bridge and its list of missing variables.
4. Check the cloud relay: `curl https://<cloud-host>/api/v1/federation/bridges`.
5. Review local logs for WebSocket errors.

### Federation sync failing

1. Verify the peer is registered: `GET /api/v1/federation/peers`.
2. Check peer reachability: `curl https://<peer-host>/health`.
3. Verify the credentials have federation scope.
4. Check the peer's event diff: `GET https://<peer-host>/api/v1/federation/diff-events`.

### Rate-limit cascades

1. Check `all_keys_rate_limited` in the health response.
2. Review key pool status: `GET /api/v1/credentials`.
3. Wait for cooldown or add accounts.
4. `pnpm test:e2e` treats capacity-limited replies (`all_keys_rate_limited`,
   `no_available_key`, `upstream_unavailable`, `rate_limit_error`) as soft.

### Policy changes not taking effect

1. Verify EDN syntax: `cljs.reader/read-string` on the file contents.
2. Check manifest order: more-specific clauses must precede catch-alls.
3. Validate contracts: `proxx.schema/assert!` on the contract map.
4. Restart the server process. Policy EDN is read from
   `resources/policies/runtime/` at startup and needs no CLJS build.
5. Verify the running process can read `resources/` (not stripped from the container).
