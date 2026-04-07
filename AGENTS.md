# Agent Skills Context

## CRITICAL: Database Migration Workflow

**Before rebuilding or restarting after any schema change**, you must:

1. Add the migration SQL to `ALL_MIGRATIONS` in `src/lib/db/schema.ts` (the single source of truth).
2. Bump `SCHEMA_VERSION` to match the new highest version in `ALL_MIGRATIONS`.
3. Run `npx tsx --test src/tests/schema-migration.test.ts` — this catches version drift, missing `IF NOT EXISTS`, and ordering errors.
4. Build with `pnpm build`.
5. Apply the SQL directly to any running database before restarting the container.

**Never hardcode migration SQL in `runMigrations()` or anywhere outside `ALL_MIGRATIONS`.** The runner iterates `ALL_MIGRATIONS` — adding SQL only to the runner without updating `ALL_MIGRATIONS` will cause the schema version to be recorded without the migration being applied.

See `DEVEL.md` > "Database Migrations" for full details.

## CRITICAL: Completion Requires Testing

**Do not mark work complete without running the relevant tests/builds for the surfaces you changed.**

### Minimum backend validation
Run these for any backend, route, auth, routing, or data-path change:

1. `pnpm build`
2. `PROXY_AUTH_TOKEN=$(grep PROXY_AUTH_TOKEN /home/err/devel/services/proxx/.env | cut -d= -f2) npx tsx --test src/tests/proxy.test.ts`

### Minimum frontend validation
Run these for any `web/` change:

1. `pnpm web:build`
2. `pnpm web:test`
3. `pnpm web:test:e2e`

### Migrations
For schema changes, also run:

1. `npx tsx --test src/tests/schema-migration.test.ts`
2. Rebuild/recreate the container after applying SQL to the running DB

### Container / packaging changes
For changes to `Dockerfile`, `docker-compose.yml`, frontend package deps, or build context:

1. `docker compose build proxx`
2. `docker compose up -d --force-recreate proxx`
3. Validate:
   - `docker compose ps proxx`
   - `curl http://localhost:8789/health`
   - `curl -I http://localhost:5174`

### Notes
- `pnpm web:test` is the fast render-smoke layer.
- `pnpm web:test:e2e` is the browser smoke layer that locks the frontend surfaces being migrated to `@open-hax/uxx`.
- If a touched surface has no test yet, add at least a smoke test before calling the work complete.

## RELEVANT SKILLS
These skills are configured for this directory's technology stack and workflow.

### testing-general
Apply testing best practices, choose appropriate test types, and establish reliable test coverage across the codebase

### workspace-code-standards
Apply workspace TypeScript and ESLint standards, including functional style and strict typing rules

### workspace-lint
Lint all TypeScript and markdown files across the entire workspace, including all submodules under orgs/**

### workspace-typecheck
Type check all TypeScript files across the entire workspace, including all submodules under orgs/**, using strict TypeScript settings

## Federation Modes

### Mode A: Isolated Local

No federation config needed. Just set `PROXY_AUTH_TOKEN` and run.

```bash
cp .env.example .env
# Edit: PROXY_AUTH_TOKEN=your-secret
pnpm dev
```

### Mode B: Multi-Tenant Local

Set `DATABASE_URL` to PostgreSQL. Tenants are isolated by API key.

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/proxx pnpm dev

# Create tenant
curl -X POST http://127.0.0.1:8789/api/v1/tenants \
  -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "team-alpha", "scopes": ["proxy:use"]}'
```

### Mode C: Federated Cloud

1. All instances share the same `DATABASE_URL`
2. Set instance identity:
   ```bash
   FEDERATION_SELF_CLUSTER_ID=production
   FEDERATION_SELF_GROUP_ID=group-a
   FEDERATION_SELF_NODE_ID=a1
   ```
3. Register peers via `/api/v1/federation/peers`
4. Use routing prefixes: `/cluster/`, `/group-a/`, `/a1.node.host/`

See `docs/promethean-federated-deployments.md` for the full promotion workflow.

### Mode D: WebSocket Bridge

Connect local to cloud without inbound ports.

**Local side config:**
```bash
FEDERATION_BRIDGE_RELAY_URL=wss://cloud.promethean.rest/api/ui/federation/bridge/ws
FEDERATION_BRIDGE_AUTHORIZATION=Bearer <bridge-token>
FEDERATION_SELF_CLUSTER_ID=local
FEDERATION_SELF_GROUP_ID=enclave
FEDERATION_SELF_NODE_ID=local-node
```

**Cloud side:**
- Bridge relay auto-starts with federation UI
- Check sessions: `GET /api/v1/federation/bridges`
- Health: `GET /api/v1/federation/bridges/{sessionId}`

**Bridge agent autostart:**
The bridge agent starts automatically when `FEDERATION_BRIDGE_RELAY_URL` is set. It:
- Initiates outbound WebSocket connection
- Advertises local capabilities (models, providers)
- Routes cloud requests to local accounts
- Reconnects with exponential backoff on disconnect

See `specs/drafts/federation-bridge-ws-v0.md` for protocol details.

## Health Checks

### Local
```bash
curl http://127.0.0.1:8789/health | jq '.'
```

### Testing
```bash
curl https://testing.proxx.ussy.promethean.rest/health | jq '.'
```

### Staging
```bash
curl https://staging.proxx.ussy.promethean.rest/health | jq '.'
```

### Production
```bash
curl https://proxx.promethean.rest/health | jq '.'
```

### Federation Status
```bash
# List bridges
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  https://proxx.promethean.rest/api/v1/federation/bridges | jq '.'

# List peers
curl -H "Authorization: Bearer $PROXY_AUTH_TOKEN" \
  https://proxx.promethean.rest/api/v1/federation/peers | jq '.'
```

## OpenAPI Contract

```bash
# Fetch spec
curl https://proxx.promethean.rest/api/v1/openapi.json > openapi.json

# Validate
npx @apidevtools/swagger-cli validate openapi.json

# Check covered paths
cat openapi.json | jq '.paths | keys[]'
```

The contract is auto-generated from Fastify route schemas via `@fastify/swagger`.

## Semantic Versioning

When updating `package.json`:

| Change Type | Version Bump | Command |
|-------------|--------------|---------|
| Breaking API change | MAJOR (X.0.0) | Update manually, document breaking changes |
| New feature/endpoint | MINOR (0.Y.0) | Increment minor version |
| Bug fix/improvement | PATCH (0.0.Z) | Increment patch version |

### Release Process

```bash
# 1. Update version in package.json
# 2. Update README.md version history table
# 3. Commit and tag
git add package.json README.md
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "Release v0.2.0: federation bridge and capacity-aware e2e"
git push origin main --tags

# 4. Publish to npm (requires NPM_TOKEN)
npm publish --access public
```

### Fork Tax Releases

After completing significant work, pay the fork tax:

```bash
# In devel workspace
./scripts/fork-tax.sh  # Creates .ημ/ artifacts
git tag -a v0.2.0 -m "Fork tax: staging promotion complete"
git push --tags
```

## Troubleshooting

### Bridge Not Connecting

1. Check relay URL is correct: `FEDERATION_BRIDGE_RELAY_URL=wss://...`
2. Verify auth token: `FEDERATION_BRIDGE_AUTHORIZATION=Bearer <valid-token>`
3. Check cloud relay is running: `curl https://cloud.host/api/v1/federation/bridges`
4. Review local logs for WebSocket errors

### Federation Sync Failing

1. Verify peer is registered: `GET /api/v1/federation/peers`
2. Check peer reachability: `curl https://peer.host/health`
3. Verify credentials have federation scope
4. Check diff endpoint: `GET https://peer.host/api/v1/federation/diff`

### Rate Limit Cascades

1. Check `all_keys_rate_limited` in health response
2. Review key pool status: `GET /api/v1/credentials`
3. Wait for cooldown or add more accounts
4. Live e2e tests skip automatically when capacity is exhausted
