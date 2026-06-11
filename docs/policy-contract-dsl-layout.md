# Policy contract DSL layout

This is the initial policy-file inventory for migrating Proxx policy behavior from TypeScript branches into an ordered EDN policy program.

The target is not a line-for-line TypeScript port. The target is a declarative, Prolog-like policy contract DSL: facts first, derived predicates/rules next, then the root decision program with backtracking.

## Runtime order

`resources/policies/runtime/00-manifest.edn` declares the expected load order:

1. `00-domain.edn` — enums, plan weights, paid-plan set, default strategy order.
2. `05-provider-seed.edn` — provider seed specs and base routes.
3. `10-model-families.edn` — model-family and exact-model facts.
4. `15-model-pricing-overrides.edn` — token-price override contracts.
5. `20-provider-capabilities.edn` — provider preference orders and request/provider capability facts.
6. `30-model-routing.edn` — ordered routing clauses. This replaces TypeScript rule arrays semantically, not mechanically.
7. `40-strategy-selection.edn` — generic strategy/provider selection rules.
8. `50-account-selection.edn` — account plan constraints, quota handling, and ordering rules.
9. `60-tenant-enforcement.edn` — model/provider/share authorization clauses.
10. `65-federation-routing.edn` — projected-account admission/order and tenant provider share-mode requirements for federation/bridge routing.
11. `70-request-queue-templates.edn` — queue policy templates and instances.
12. `90-router.edn` — root policy program and strategy bindings.

## Current TypeScript behavior covered

- GLM, Claude, GPT-OSS, GPT paid-only, GPT 6+, GPT catch-all, and final catch-all routing order.
- Provider preference orders for GPT, GPT-OSS, Claude, and GLM.
- Provider/request strategy capability rules for Gemini, Z.ai, Rotussy, OpenAI-compatible chat providers, images passthrough, and responses passthrough.
- Default strategy ordering.
- Paid-plan weights and free-tier blocked GPT models.
- Tenant model/provider allow/deny checks and federated provider share-mode authorization.
- Federation projected-account admission/order and relay/warm-import share-mode requirements.

## Intentional gap

These files are the target policy inventory. They are valid EDN, but they are not yet all accepted by the current `proxx.policy.loader` schema, which only supports the first vertical-slice tree shape under `resources/policies/model-router.edn`.

The next migration step is to teach the CLJS policy loader/runtime to load this manifest shape and compile these declarative facts/clauses into the existing runtime decision phases.
