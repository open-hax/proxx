# Deployment ownership and retired Promethean lane

## Current authority

Proxx owns application behavior and deployable application packaging. The
`open-hax/services` repository owns host placement, environment promotion,
remote identities, runtime paths, trust material, and the decision to deploy a
Proxx revision.

There is no approved replacement staging or testing target in this repository.
A future deployment integration must start with a Services-owned contract; it
must not infer a host, SSH user, path, secret, or host-key bootstrap from the
retired lane.

## Retired active entry points

The following Proxx-controlled callers were removed because they granted this
repository active deployment authority through the legacy Services reusable
workflow:

| Former caller | Former trigger | Disposition |
| --- | --- | --- |
| `.github/workflows/deploy-production.yml` | push to `main` or manual dispatch | removed |
| `.github/workflows/deploy-staging.yml` | push to `staging` or manual dispatch | removed |
| `.github/workflows/deploy-testing.yml` | label-gated pull-request event | removed |

The direct `scripts/deploy-remote.sh` and `scripts/deploy-target.sh` SSH entry
points and their two checked-in `deploy/targets/` environment files were also
removed. They carried legacy Promethean hosts, the `error` account,
`/home/error` paths, and trust-on-first-use host-key handling.

`.github/workflows/deployment-authority.yml` runs the
`scripts/check-deployment-authority.py` policy from the pull request's immutable
base revision and scans the candidate checkout strictly as data. Candidate
changes therefore cannot weaken the scanner that judges the same pull request.
The policy fails CI if any retired authority form returns to workflows,
composite actions, script entry points, or checked-in deployment targets.

GitHub sources `pull_request_target` workflow definitions from the default
branch. The push boundary therefore starts when this retirement lands on
`staging`, while isolated pull-request enforcement starts when the canonical
`staging -> main` promotion places the reviewed workflow on the default branch.
Exact-head external review is the bootstrap boundary for this retirement PR;
the new workflow never executes candidate content.

## Assets that remain

Compose files, Caddy templates, runtime policy resources, and local federation
bootstrap helpers describe how the Proxx application can run. They do not
authorize a remote deployment and do not select a Services target. Historical
reports and receipts remain as append-only evidence; they are not current
runbooks.

## Reintroducing deployment

A future Proxx PR may consume a new Services-owned deployment interface only
after that interface is approved and documents all of the following:

1. the Services workflow or release contract and an immutable revision;
2. the environment and promotion rule;
3. the owner of remote identity and host-key material;
4. rollback and health-verification evidence; and
5. the repository in which placement changes are reviewed.

Until then, merges to Proxx branches build and test the application but do not
deploy it. The cross-repository retirement is tracked by
`open-hax/services#22`; Proxx staging protection remains governed by
`open-hax/proxx#308`.
