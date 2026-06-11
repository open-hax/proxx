# Proxx default policies

These are the **defaults** that ship with Proxx. They assume:

- a **single node** — no federation peers, zero sharing;
- a **single user** — Proxx is a dashboard plus a router for that user's own
  requests, to the providers they have configured;
- credentials belong to the operator and are never granted outward.

Most deployments run the compose files in this repo and edit these policies in
place. That is the supported path: change the files here (or in a mounted copy)
and the runtime observes valid changes without a rebuild.

The single-node assumption is enforced by the defaults themselves:

- `runtime/60-tenant-enforcement.edn` — `:tenant/provider-share-policy` is
  **default `:deny`**: nothing is shared with a federated peer unless an
  explicit share grant says otherwise.
- `runtime/65-federation-routing.edn` — describes how federated providers
  would be admitted and ordered, but is **inert until peers exist**. With no
  peers and no share grants it matches nothing.

## Running something other than a single node

Don't grow these defaults into a multi-tenant config. Instead give that
deployment its own policy tree and point `PROXX_CLJS_POLICY_MANIFEST` (or the
compose mount at `/etc/proxx/policies`) at it:

- a **peer node** deployment keeps its own tree (e.g. a workstation's
  `services/proxx/resources/policies`), seeded from these defaults and free to
  diverge;
- a **relay** node (community-pooled credentials, access tiers, peer
  admission) is owned by its services repo — see
  `open-hax/services` `contracts/proxx/policies`.

## Layout

- `runtime/` — the manifest-loaded contract set. `runtime/00-manifest.edn`
  lists the load order: facts first, then derived rules, then the root router.
  More-specific clauses must precede catch-all clauses.
- `model-router.edn`, `contract-router.edn` — standalone router policy trees
  (eval-form DSL) predating the manifest-loaded runtime set.
