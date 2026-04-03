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
