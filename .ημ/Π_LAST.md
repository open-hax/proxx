# Π Fork Tax Snapshot: open-hax-proxx

- timestamp: 2026-05-15T06:01:45Z
- repo: /home/err/devel/orgs/open-hax/proxx
- branch: feat/policy-polish
- head-before: 63759ac970550e5b28b5f6ecacf426d615f9f886
- origin: git@github.com:open-hax/proxx.git
- scope: .
- note: Proxx policy/routing snapshot.

## Dirty summary before commit

```text
## feat/policy-polish
 M .env.example
 M DEVEL.md
 M README.md
 M docker-compose.yml
 M receipts.edn
 M resources/policies/runtime/05-provider-seed.edn
 M resources/policies/runtime/10-model-families.edn
 M resources/policies/runtime/20-provider-capabilities.edn
 M resources/policies/runtime/30-model-routing.edn
 M src/lib/catalog-alias-resolver.ts
 M src/lib/config.ts
 M src/lib/policy/cljs-shadow.ts
 M src/lib/policy/engine/tenant-enforcement.ts
 M src/lib/provider-routing.ts
 M src/lib/provider-strategy/registry.ts
 M src/lib/provider-strategy/routing/attempt-executor.ts
 M src/lib/provider-strategy/routing/candidate-builder.ts
 M src/lib/provider-strategy/shared.ts
 M src/lib/provider-strategy/strategies/ollama.ts
 M src/proxx/policy/contracts.cljs
 M src/routes/chat.ts
 M src/routes/embeddings.ts
 M src/routes/media-generations.ts
 M src/tests/cljs-policy-preview.test.ts
 M src/tests/model-alias-resolution.test.ts
 M src/tests/provider-routing.test.ts
 M test/proxx/policy_test.cljs
```

## Verification plan

- git diff --cached --check after staging
- push branch and tag
- create or update GitHub PR

## Concurrent/residual dirt policy

Unrelated dirty paths outside the scope are intentionally left untouched. Nested submodules with local-only dirt that are not part of the requested scope are recorded as residual rather than cleaned.
