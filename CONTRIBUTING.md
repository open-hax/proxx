# Contributing to Proxx

Thanks for contributing.

This repository has a **single trunk: `main`**. There is no `staging` branch and no promotion flow.

- **Branch from `main` and open your PR against `main`.**
- Merge into `main` once the PR gate is green and review is settled.
- Deployment is not done from this repository. `open-hax/services` (the `services` repo in the Foresight workspace) builds Proxx from a ref of this repository using the root `Dockerfile`, and deploys the whole stack so the services are integration-tested together. See [`docs/deployment-ownership.md`](docs/deployment-ownership.md).

## Branch and PR policy

For features, fixes, refactors, docs, and workflow changes:

1. Branch from current `main`
2. Open your PR against `main`
3. Let the PR gate pass (below) and settle review
4. Merge into `main`
5. To ship a revision, open a reviewed `open-hax/services` PR that bumps its Proxx ref

Changes that make the root `Dockerfile` unbuildable, change how the container starts (`dist/cljs/main.js`), or change the `/health` contract affect `open-hax/services` and should say so in the PR description.

## Local setup

```bash
pnpm install
cp .env.example .env
cp keys.example.json keys.json
cp models.example.json models.json
```

Then configure real credentials through one of:

- `keys.json`
- `PROXY_KEYS_JSON` / `UPSTREAM_KEYS_JSON`
- SQL-backed runtime state via `DATABASE_URL`

Unless you are explicitly doing local unauthenticated debugging, set:

```bash
PROXY_AUTH_TOKEN=...
```

## Useful local commands

### Core development
```bash
pnpm run check:no-new-typescript
pnpm test
pnpm run build
pnpm run web:build
```

### Local runtime
```bash
pnpm dev
pnpm web:dev
```

### Lint / workflow checks
```bash
./scripts/ci-lint.sh
actionlint .github/workflows/*.yml
```

### Live / environment-sensitive checks
These hit a real running proxy and are usually most relevant for deploy, auth, tenancy, routing, or end-to-end changes:

```bash
./scripts/e2e-test.sh
./scripts/e2e-multitenancy-smoke.sh
```

## What CI expects

### PRs into `main`
- `main-lint`
- `main-typecheck` (runs `pnpm run check:no-new-typescript`; the runtime is ClojureScript and the repo carries no TypeScript)
- `main-unit-tests`
- `main-coverage`
- `main-build`
- `main-web-build`

### Pushes to `main`
Application validation only:

- `production-preflight` (packaging checks; it contains no deployment job)

Production deployment and live verification run from a reviewed
`open-hax/services` pull request carrying `deploy` at merge time.

## Contributor checklist

Before opening a PR, try to ensure:

- the branch was created from current `main`
- `pnpm run check:no-new-typescript` passes
- `pnpm test` passes
- docs are updated if behavior changed
- no secrets were committed
- workflow changes were checked with `actionlint`
- container/runtime changes include the smallest realistic verification path (build the image, check `/health`)

## Workflow changes

If you change anything under `.github/workflows/`:

- keep deployment out of this repository (it belongs to `open-hax/services`)
- do **not** check out untrusted fork code from `pull_request_target`
- validate with `actionlint`

## Secrets and credentials

Never commit:

- API keys
- OAuth tokens
- SSH private keys
- session secrets
- production/staging env files

Use GitHub Actions secrets, local ignored files, or runtime environment variables instead.

## Notes on scope

Prefer small, atomic PRs. If a change affects routing, auth, tenancy, deployments, or CI policy, say so clearly in the PR description and include the exact commands or checks you used to verify it.
