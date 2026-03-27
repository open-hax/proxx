# Promethean host runtime inventory — big.ussy predeploy check

Generated: 2026-03-26 20:19 -0500

## Target
- Public host: `big.ussy.promethean.rest`
- Resolved host identity after SSH: `pve.ussy.cloud`
- SSH target used: `error@big.ussy.promethean.rest`

## Objective
Validate whether `big.ussy` is ready to receive the current `proxx` deployment flow driven by:
- `scripts/deploy-remote.sh`
- `docker-compose.federation-runtime.yml`
- `deploy/docker-compose.federation.ssl.yml`
- `deploy/docker-compose.production.shared-edge.yml`
- `.github/workflows/deploy-production.yml`

## Facts

### Host / runtime
- Docker is installed and usable by `error`.
- `docker compose` is available (`5.1.1`).
- `docker` systemd service is active.
- The host is a Proxmox-style node (`/etc/pve` present).
- Disk and memory are healthy enough for deployment:
  - root/home filesystem: 197G total, 85G free
  - memory: 15Gi total, ~9.9Gi available

### Current deployment target path
`/home/error/devel/services/proxx`
- writable by `error`
- contains:
  - `.env`
  - `docker-compose.yml`
- missing:
  - `keys.json`
  - `models.json`
  - `deploy/docker-compose.federation.ssl.yml`
  - `deploy/docker-compose.production.shared-edge.yml`
  - `deploy/Caddyfile.production.template`
  - `docker-compose.federation-runtime.yml`

Missing compose overlays/templates are not fatal by themselves because `scripts/deploy-remote.sh` will sync repo files. Missing `keys.json` / `models.json` is a real blocker because the deploy script excludes them from rsync unless explicitly provided or pre-existing remotely.

### Current live runtime on the host
The active proxx-like runtime is **not** the target path compose project.

Active containers include:
- `cephalon-hive-proxx-1` — binds `8789` and `5174`
- `cephalon-hive-proxx-db-1`
- `openhax-eta-mu` — binds `8790`
- `openhax-eta-mu-staging` — binds `8791`

Running compose path observed:
- `/home/error/devel/services/cephalon-hive`

Meanwhile:
- `cd ~/devel/services/proxx && docker compose -f docker-compose.yml ps`
- returned an empty project state

This means the host already has a live proxx-serving stack elsewhere, and the new deploy target is not the currently active one.

### Public routing / edge state
- Port `80` is already listening.
- Port `443` is already listening.
- A host-level **systemd Caddy** service is active.
- `/etc/caddy/Caddyfile` currently routes:
  - `eta.mu.promethean.rest` -> `127.0.0.1:8790`
  - `staging.eta-mu.promethean.rest` -> `127.0.0.1:8791`
  - `federation.big.ussy.promethean.rest` / `brethren.big.ussy.promethean.rest` -> `127.0.0.1:8789` and `127.0.0.1:5174`

Observed behavior:
- `http://127.0.0.1/` -> `308` redirect from Caddy to HTTPS
- `http://127.0.0.1:8789/health` responds `200`
- `http://127.0.0.1:5174/` responds `200`

Caddy logs also show ACME/DNS failures for:
- `federation.big.ussy.promethean.rest`
- `brethren.big.ussy.promethean.rest`

with `NXDOMAIN` on A/AAAA lookup.

### Network prerequisites vs planned production overlay
The planned production deploy uses:
- `docker-compose.federation-runtime.yml`
- `deploy/docker-compose.federation.ssl.yml`
- `deploy/docker-compose.production.shared-edge.yml`

Those require external networks:
- `ai-infra`
- `battlebussy-prod_default`
- `voxx_default`

Current host state:
- `ai-infra` -> **missing**
- `battlebussy-prod_default` -> **missing**
- `voxx_default` -> **missing**

The deploy script creates `ai-infra` automatically, but it does **not** create `battlebussy-prod_default` or `voxx_default`.

## Readiness judgment

## Not ready for the current production deploy flow as-is.

### Blocking issues
1. `keys.json` missing at `~/devel/services/proxx`
2. `models.json` missing at `~/devel/services/proxx`
3. `battlebussy-prod_default` network missing
4. `voxx_default` network missing
5. Existing live `cephalon-hive-proxx-1` already occupies `8789` and `5174`
6. Host-level Caddy already occupies `80` and `443`, which conflicts with the dockerized `open-hax-openai-proxy-ssl` service in the planned deploy

### Non-blocking but important caveats
- The host is not a clean app node; it is a mixed-use Proxmox host with existing routing and service responsibilities.
- Current public routing on big ussy is for `federation.big.ussy.promethean.rest` / `brethren.big.ussy.promethean.rest`, while the checked-in production workflow is written around `ussy.promethean.rest` defaults unless overridden.
- DNS/certificate state for the existing big-ussy federation hosts is already unhealthy (`NXDOMAIN`), so even a successful runtime deploy would still need DNS correction for TLS success.

## Recommended predeploy actions
1. Decide whether big ussy should:
   - replace the current `cephalon-hive-proxx` runtime, or
   - host a second isolated proxx stack on different ports/paths.
2. Decide whether TLS should remain host-level Caddy or move into dockerized Caddy.
   - Do **not** attempt both on `80/443` simultaneously.
3. Provide runtime files at the target path before deploy, or set deploy env to sync them:
   - `keys.json`
   - `models.json`
4. Create or remove dependency on these external networks:
   - `battlebussy-prod_default`
   - `voxx_default`
5. Fix DNS for the intended public hostnames before expecting automated Caddy certificate issuance to succeed.

## Bottom line
The host itself is healthy and reachable, and the target directory is writable. But the environment is **not ready to receive the current checked-in production deployment unchanged**. The current deploy flow would likely fail on missing runtime files, missing external networks, and port conflicts with the existing live stack and host-level Caddy.
