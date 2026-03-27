# Π Snapshot: Proxx control-plane extraction + Big Ussy bundle

- **Repo:** `open-hax/proxx`
- **Branch:** `fix/ci-live-e2e-aggregate-conclusion`
- **Pre-snapshot HEAD:** `c5fba82`
- **Previous tag:** `Π/2026-03-26/194400`
- **Intended Π tag:** `Π/2026-03-27/043215`
- **Generated:** `2026-03-27T04:32:15Z`

## What this snapshot preserves

This Π handoff captures the full current working tree the user asked to preserve.

Included work categories:
- control-plane/UI route extraction for credentials, sessions, settings, and federation
- OAuth account identity derivation plus tenant/provider share-policy persistence
- quota/request-log/request-usage plumbing and expanded proxy regression coverage
- Big Ussy hub/spokes deployment compose assets, target envs, and deploy helpers
- refactor/deprecation specs and fresh host inventory reports for the new deployment shape

## Dirty state before commit

### Modified
- `scripts/deploy-remote.sh`
- `specs/drafts/open-hax-openai-proxy-multitenancy-user-model.md`
- `specs/drafts/tenant-federation-cloud-roadmap.md`
- `specs/lint-complexity-reduction/ui-routes-flattening.spec.md`
- `src/app.ts`
- `src/lib/credential-store.ts`
- `src/lib/db/schema.ts`
- `src/lib/db/sql-credential-store.ts`
- `src/lib/db/sql-request-usage-store.ts`
- `src/lib/openai-quota.ts`
- `src/lib/provider-strategy/shared.ts`
- `src/lib/request-log-store.ts`
- `src/lib/ui-routes.ts`
- `src/routes/api/v1/index.ts`
- `src/routes/credentials/index.ts`
- `src/routes/events/index.ts`
- `src/routes/federation/index.ts`
- `src/routes/hosts/index.ts`
- `src/routes/index.ts`
- `src/routes/mcp/index.ts`
- `src/routes/sessions/index.ts`
- `src/routes/settings/index.ts`
- `src/routes/ui/index.ts`
- `src/tests/proxy.test.ts`
- `web/src/lib/api.ts`
- `web/src/pages/CredentialsPage.tsx`
- `web/src/styles.css`

### Untracked
- `deploy/docker-compose.big-ussy.host-caddy.yml`
- `deploy/docker-compose.big-ussy.hub-spokes.yml`
- `deploy/targets/big-ussy-hub-spokes.env`
- `deploy/targets/big-ussy-owned-relay.env`
- `docs/reports/inventory/promethean-host-runtime-inventory-2026-03-26-big-ussy.json`
- `docs/reports/inventory/promethean-host-runtime-inventory-2026-03-26-big-ussy.md`
- `scripts/bootstrap-big-ussy-hub-spokes.sh`
- `scripts/deploy-target.sh`
- `specs/drafts/control-plane-api-contract-v1.md`
- `specs/drafts/control-plane-mvc-transition-roadmap.md`
- `specs/drafts/control-plane-slice-credentials-auth-v1.md`
- `specs/drafts/control-plane-slice-federation-v1.md`
- `specs/drafts/control-plane-slice-observability-v1.md`
- `specs/drafts/control-plane-slice-settings-sessions-v1.md`
- `specs/drafts/federated-tenant-provider-share-policies.md`
- `specs/drafts/legacy-api-ui-deprecation.md`
- `src/lib/account-identity.ts`
- `src/lib/db/sql-tenant-provider-policy-store.ts`
- `src/lib/tenant-provider-policy.ts`
- `src/routes/credentials/account-management-ui.ts`
- `src/routes/credentials/context.ts`
- `src/routes/credentials/factory-browser-oauth-ui.ts`
- `src/routes/credentials/factory-device-oauth-ui.ts`
- `src/routes/credentials/get-credentials-ui.ts`
- `src/routes/credentials/openai-browser-oauth-ui.ts`
- `src/routes/credentials/openai-device-oauth-ui.ts`
- `src/routes/credentials/openai-probe-ui.ts`
- `src/routes/credentials/openai-quota-ui.ts`
- `src/routes/credentials/openai-refresh-ui.ts`
- `src/routes/credentials/prefix.ts`
- `src/routes/credentials/ui.ts`
- `src/routes/federation/ui.ts`
- `src/routes/sessions/context.ts`
- `src/routes/sessions/prefix.ts`
- `src/routes/sessions/ui.ts`
- `src/routes/settings/delete-tenant-api-key-ui.ts`
- `src/routes/settings/get-me-ui.ts`
- `src/routes/settings/get-settings-ui.ts`
- `src/routes/settings/get-tenant-api-keys-ui.ts`
- `src/routes/settings/get-tenants-ui.ts`
- `src/routes/settings/post-settings-ui.ts`
- `src/routes/settings/post-tenant-api-keys-ui.ts`
- `src/routes/settings/post-tenant-select-ui.ts`
- `src/routes/settings/prefix.ts`
- `src/routes/settings/ui.ts`
- `src/routes/shared/ui-auth.ts`
- `src/routes/types.ts`
- `src/tests/account-identity.test.ts`
- `src/tests/sql-tenant-provider-policy-store.test.ts`
- `src/tests/tenant-provider-policy-routes.test.ts`
- `src/tests/tenant-provider-policy.test.ts`

## Verification

- Secret scan: added-line scan found only dummy fixture placeholders (`viv-secret-a`) in tests
- Typecheck: `pnpm run typecheck` ✅
- Test suite: `pnpm test` ✅ (`419/419`)
- Web build: `pnpm run web:build` ✅
- Deploy compose validation: hub/spokes + owned-relay compose configs validated with target env files ✅
- Deploy script syntax: `bash -n scripts/deploy-target.sh scripts/bootstrap-big-ussy-hub-spokes.sh scripts/deploy-remote.sh` ✅

## Operator note

This snapshot is intended as the clean, pushable Proxx handoff before the workspace superproject advances its submodule pointer.
