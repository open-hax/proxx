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
