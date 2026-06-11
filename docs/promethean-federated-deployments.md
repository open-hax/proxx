# Promethean federated deployments

## Goal

Run the federated `proxx` promotion flow with three named public surfaces:

- staging: `staging.proxx.ussy.promethean.rest`
- testing: `testing.proxx.ussy.promethean.rest`
- production: `prod.proxx.ussy.promethean.rest`

The production hostname above is the normalized default used by the workflows. If you truly want a different label, override `PRODUCTION_PUBLIC_HOST` in GitHub vars.

## Branch and trigger contract

- feature work lands by PR into `staging`
- pushes to `staging` deploy the staging environment
- promotion PRs go from `staging` into `main`
- pushes to `main` deploy production
- PRs labeled `testing` deploy the shared testing slot **only** when the PR author login is present in `TESTING_ALLOWED_OWNER_LOGINS`

## Environment mapping

Public host labels are intentionally decoupled from the SSH/runtime hosts so the labels stay stable while runtime placement stays flexible.

| Environment | Git trigger | Public host | SSH host | Deploy path | Compose project |
| --- | --- | --- | --- | --- | --- |
| staging | push to `staging` | `staging.proxx.ussy.promethean.rest` | `ussy3.promethean.rest` | `~/devel/services/proxx-staging` | `proxx-staging` |
| testing | testing-labeled PR by allowed owner | `testing.proxx.ussy.promethean.rest` | `ussy2.promethean.rest` | `~/devel/services/proxx-testing` | `proxx-testing` |
| production | push to `main` | `prod.proxx.ussy.promethean.rest` | `ussy.promethean.rest` | `~/devel/services/proxx` | `open-hax-openai-proxy` |

## Runtime shape

All three environments use the federation runtime compose stack plus the federation TLS edge:

- `docker-compose.federation-runtime.yml`
- `deploy/docker-compose.federation.ssl.yml`
- `deploy/Caddyfile.federation.template`

Staging and testing seed their runtime env/models files and non-secret control-plane state from production by default:

- source host: `ussy.promethean.rest`
- source path: `~/devel/services/proxx`
- source compose project: `open-hax-openai-proxy`

Credential state is **not** shipped as `keys.json` in this flow, and OAuth refresh tokens should not be copied between hosts.

- `keys.json` is treated as a one-time seed artifact for older/manual setups.
- federated Promethean deploys rely on each environment's SQL credential store for local credentials.
- staging/testing may sync schema migrations, service configuration metadata, routing tables, feature flags, analytics aggregates, and other non-secret control-plane runtime state.
- staging/testing must not receive credential tables, OAuth refresh tokens, API keys, secret keys, or service-account secrets through DB sync.
- cross-environment access should use federation peer projection or the WebSocket bridge, where remote nodes route or lease access without owning the source refresh token.
- production keeps its credential state in its own persistent DB volume.

That means first-time bring-up should either:

1. deploy production first and let downstream environments sync only the non-secret artifacts listed above, or
2. bootstrap credentials directly into the production SQL-backed runtime through the UI/API/provider env vars and expose cross-environment use through peer projection or bridge routing.

## Policy runtime contract

Provider/model routing, account ordering, federation relay admission, warm-import eligibility, tenant provider share-mode checks, and queue policy are owned by the CLJS/EDN policy runtime:

- EDN contracts: `resources/policies/runtime/*.edn`
- Federation routing clause: `resources/policies/runtime/65-federation-routing.edn`
- CLJS interpreters: `src/proxx/**/*.cljs`
- TypeScript responsibility: HTTP routes, storage facts, and transport execution

Do not add provider/model/federation routing exceptions to `.env`, Compose files, `models.json`, or TypeScript branches. Mount a complete policy directory and set `PROXX_CLJS_POLICY_MANIFEST=/etc/proxx/policies/runtime/00-manifest.edn` when an environment needs policy overrides.

## Shared testing slot

`testing` is a single shared slot.

- concurrency group: `proxx-testing`
- the latest qualifying PR event wins
- do not keep multiple owner PRs labeled `testing` unless you intentionally want them to overwrite each other

## Required GitHub vars and secrets

### Repo/org variables

- `STAGING_PUBLIC_HOST`, `STAGING_BASE_URL`, `STAGING_SSH_HOST`, `STAGING_DEPLOY_PATH`, `STAGING_COMPOSE_PROJECT_NAME`
- `TESTING_PUBLIC_HOST`, `TESTING_BASE_URL`, `TESTING_SSH_HOST`, `TESTING_DEPLOY_PATH`, `TESTING_COMPOSE_PROJECT_NAME`
- `PRODUCTION_PUBLIC_HOST`, `PRODUCTION_BASE_URL`, `PRODUCTION_SSH_HOST`, `PRODUCTION_DEPLOY_PATH`, `PRODUCTION_COMPOSE_PROJECT_NAME`
- `TESTING_ALLOWED_OWNER_LOGINS` — comma/space separated GitHub logins allowed to use the shared testing slot
- optional `*_VERIFY_RESOLVE_ADDRESS` when DNS is not ready but HTTPS validation should still pin the public hostname

### Environment secrets

- staging:
  - `STAGING_SSH_PRIVATE_KEY`
  - `STAGING_PROXY_AUTH_TOKEN`
  - optional `STAGING_ENV_FILE`, `STAGING_MODELS_JSON`
- testing:
  - `TESTING_SSH_PRIVATE_KEY`
  - `TESTING_PROXY_AUTH_TOKEN`
  - optional `TESTING_ENV_FILE`, `TESTING_MODELS_JSON`
- production:
  - `PRODUCTION_SSH_PRIVATE_KEY`
  - `PRODUCTION_PROXY_AUTH_TOKEN`
  - recommended `PRODUCTION_ENV_FILE`, `PRODUCTION_MODELS_JSON` for first-time bootstrap into `~/devel/services/proxx`

## GitHub settings follow-through

1. Protect `staging` and `main`.
3. Require these status checks:
   - `staging-lint`
   - `staging-typecheck`
   - `staging-unit-tests`
   - `main-lint`
   - `main-typecheck`
   - `main-unit-tests`
   - `main-build`
   - `main-web-build`
   - `staging-promotion-gate`
4. Create GitHub environments:
   - `staging`
   - `testing`
   - `production`
5. Add DNS for the three public hosts and point each one at the intended runtime host/IP.

## Notes

- The production promotion workflows enforce `staging -> main`; non-staging PRs aimed at `main` are retargeted back to `staging`.
- The testing workflow is fail-closed: if `TESTING_ALLOWED_OWNER_LOGINS` is unset, no testing deployment occurs.
- `keys.json` is intentionally outside the Promethean federated deploy contract; treat it as a legacy/manual bootstrap seed, not a required deployment artifact.
- These workflows only manage repo-side CI/CD. DNS records, environment secrets, and branch protection still require GitHub/Cloudflare follow-through.
