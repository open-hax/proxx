# Π Last Snapshot — defaults policy-tree README + staging promotion

- Timestamp: 2026-06-03T20:14:11Z
- Repo: `/home/err/devel/orgs/open-hax/proxx`
- Branch: `devops/promethean-service-module-deploy`
- Base target: `origin/staging`

## State

The promethean-module deploy commit (74b8b85) is already merged into
`origin/staging` (as 0269ada). The only remaining working-tree dirt was
`resources/policies/README.md`, new documentation for the **defaults**
policy tree.

## Changed

- `resources/policies/README.md` — documents the single-node/single-user
  assumptions of the shipped defaults, the `:deny`-by-default tenant share
  policy (`runtime/60-tenant-enforcement.edn`), the inert-until-peers
  federation routing (`runtime/65-federation-routing.edn`), and the rule
  that peer-node / Promethean-relay deployments get their OWN policy trees
  via `PROXX_CLJS_POLICY_MANIFEST` instead of growing the defaults.
  Encodes the three-policy-trees doctrine: defaults vs local peer vs
  Promethean relay; never consolidate. (The relay tree itself is preserved
  in open-hax/services @ Π/20260603T201215Z snapshot, contracts/proxx/policies.)

## Boundary

- Docs-only change; no secrets.
- Path-scoped staging; no repo-wide reset/restore/clean.
- No concurrent dirt present at snapshot time (tree otherwise clean).

## Verification

- Both policy files referenced by the README exist in
  `resources/policies/runtime/` (60-tenant-enforcement, 65-federation-routing).
- `pnpm run lint` (workspace, including `orgs/**`) passed.
- Docs-only change; build/test gates deferred to PR CI (staging-typecheck,
  staging-unit-tests).

## Follow-up

- PR `devops/promethean-service-module-deploy` → `staging`.
- Add `testing` label → label-gated test deploy via
  `.github/workflows/deploy-testing.yml` (direct ssh slot, ussy2).
- Staging push deploy routes through
  `open-hax/services/.github/workflows/deploy-promethean.yml@main`
  (service: proxx).
