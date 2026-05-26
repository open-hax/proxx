# Proxx source architecture and functional TypeScript contract

Date: 2026-05-21
Status: draft
Scope: `src/`, `resources/policies/runtime/`, route wiring, TypeScript lint posture

## Purpose

Proxx should stop treating `src/lib/` as a dumping ground. The source tree should make the system's real boundaries visible:

```text
HTTP edge (TypeScript) -> CLJS runtime boundary -> declarative policy engine (EDN + CLJS)
```

TypeScript remains the HTTP/IO adapter layer. ClojureScript and EDN own semantic policy: routing, model-family classification, provider ordering, account ordering, tenant enforcement, and queue behavior.

This document records the intended source structure, the key domain concepts, behavior contracts, Knoxx-aligned structural guidelines, and a staged plan for making TypeScript lint more like data-oriented functional code.

## Design doctrine

### 1. Semantic policy is data plus interpreter

Policy facts and rules belong in EDN contracts under `resources/policies/runtime/`. CLJS interprets those contracts through `src/proxx/**`. TypeScript may call the CLJS runtime, adapt outputs, and execute IO, but must not become a second semantic router.

Examples of logic that belongs in EDN/CLJS, not TypeScript:

- model family matching;
- provider preference and exclusion;
- request-surface strategy selection;
- account ordering and plan constraints;
- tenant provider/model authorization;
- request queue templates and retry/backoff policy.

### 2. TypeScript is an edge and adapter language

TypeScript should do:

- Fastify route registration;
- request parsing and OpenAI-compatible response serialization;
- upstream HTTP calls;
- provider wire-format adaptation;
- database adapters and durable stores;
- auth/token IO;
- telemetry/log emission;
- CLJS runtime invocation.

TypeScript should avoid:

- implicit routing semantics hidden in helper conditionals;
- mutable global policy state outside explicit runtime/dependency objects;
- classes when a plain data shape plus pure functions is enough;
- cross-domain helper imports from deep implementation files.

### 3. Data shapes are first-class

Data crossing a boundary should have an explicit shape:

- route request/response shape;
- provider route shape;
- credential/account shape;
- policy preview/result shape;
- provider strategy context/outcome shape;
- tenant auth/provider-policy shape;
- DB row and projection shape;
- observability event shape;
- federation bridge/projection shape.

Prefer `readonly` plain records, discriminated unions, parser/normalizer functions, and explicit result maps over mutable objects and implicit side effects.

### 4. Vertical domains over horizontal junk drawers

Follow the Knoxx direction: domain slices should own their private helpers and public API. Shared helpers are promoted deliberately to `support/*`; they are not grabbed from another domain's internals.

Bad:

```text
src/lib/misc.ts
src/lib/provider-utils.ts          # grows until every domain imports it
src/lib/request-helpers.ts         # mixes HTTP, auth, routing, and provider concerns
```

Better:

```text
src/providers/routing/provider-routes.ts
src/providers/strategies/shared.ts
src/edge/openai-compatible/request-handling.ts
src/support/http/fetch-utils.ts
```

## Proposed source map

```text
src/
  app/
    create-app.ts
    deps.ts
    config.ts

  edge/
    fastify/
    openai-compatible/
    routes/

  policy/
    cljs-runtime.ts
    policy-client.ts
    policy-types.ts
    runtime-contracts.ts

  providers/
    accounts/
    catalog/
    compatibility/
    credentials/
    pricing/
    quota/
    routing/
    strategies/
    support/

  tenants/
    api-keys/
    auth/
    provider-policy/
    settings/

  persistence/
    db/
    migrations/
    stores/

  federation/
    bridge/
    peers/
    projection/
    relay/
    remote/

  sessions/
    retrieval/

  observability/
    dashboard/
    events/
    request-log/
    telemetry/

  support/
    errors/
    http/
    mcp/
    security/
    sse/
    time/
```

`src/lib/` should become a temporary compatibility layer only. During migration, `src/lib/foo.ts` may re-export from the new location, but new implementation code should not be added there.

## Current-to-target migration map

| Current path | Target path |
| --- | --- |
| `src/lib/app-deps.ts` | `src/app/deps.ts` |
| `src/lib/config.ts` | `src/app/config.ts` |
| `src/app.ts` | `src/app/create-app.ts` |
| `src/lib/proxy.ts` | `src/edge/openai-compatible/proxy-headers.ts` |
| `src/lib/request-utils.ts` | `src/edge/openai-compatible/request-utils.ts` |
| `src/lib/response-utils.ts` | `src/edge/openai-compatible/response-utils.ts` |
| `src/lib/openai/request-handling.ts` | `src/edge/openai-compatible/request-handling.ts` |
| `src/lib/fastify-types.ts` | `src/edge/fastify/types.ts` |
| `src/lib/http/*` | `src/support/http/*` |
| `src/lib/sse/*` | `src/support/sse/*` |
| `src/lib/errors/*` | `src/support/errors/*` |
| `src/lib/epoch.ts` | `src/support/time/epoch.ts` |
| `src/lib/account-identity.ts` | `src/support/security/account-identity.ts` |
| `src/lib/tool-mcp-seed.ts` | `src/support/mcp/tool-mcp-seed.ts` |
| `src/lib/cljs-runtime.ts` | `src/policy/cljs-runtime.ts` |
| `src/lib/model-routing-pipeline.ts` | `src/policy/model-routing-pipeline.ts` |
| `src/lib/catalog-resolution.ts` | `src/policy/catalog-resolution.ts` |
| `src/lib/catalog-alias-resolver.ts` | `src/policy/catalog-alias-resolver.ts` |
| `src/lib/provider-routing.ts` | `src/providers/routing/provider-routes.ts` |
| `src/lib/routing-outcome-handler.ts` | `src/providers/routing/outcome-handler.ts` |
| `src/lib/provider-route-aco.ts` | `src/providers/routing/aco.ts` |
| `src/lib/provider-route-pheromone-store.ts` | `src/providers/routing/pheromone-store.ts` |
| `src/lib/provider-strategy/**` | `src/providers/strategies/**` |
| `src/lib/provider-utils.ts` | `src/providers/support/provider-utils.ts` |
| `src/lib/provider-catalog.ts` | `src/providers/catalog/store.ts` |
| `src/lib/models.ts` | `src/providers/catalog/models.ts` |
| `src/lib/model-family.ts` | `src/providers/catalog/model-family.ts` |
| `src/lib/dynamic-ollama-routes.ts` | `src/providers/catalog/dynamic-ollama-routes.ts` |
| `src/lib/model-pricing.ts` | `src/providers/pricing/model-pricing.ts` |
| `src/lib/data/*` | `src/providers/pricing/data/*` |
| `src/lib/key-pool.ts` | `src/providers/accounts/key-pool.ts` |
| `src/lib/credential-store.ts` | `src/providers/credentials/file-credential-store.ts` |
| `src/lib/runtime-credential-store.ts` | `src/providers/credentials/runtime-credential-store.ts` |
| `src/lib/factory-auth.ts` | `src/providers/credentials/factory-auth.ts` |
| `src/lib/factory-oauth.ts` | `src/providers/credentials/factory-oauth.ts` |
| `src/lib/openai-oauth.ts` | `src/providers/credentials/openai-oauth.ts` |
| `src/lib/token-refresh-manager.ts` | `src/providers/credentials/token-refresh-manager.ts` |
| `src/lib/token-refresh-handlers.ts` | `src/providers/credentials/token-refresh-handlers.ts` |
| `src/lib/openai-quota.ts` | `src/providers/quota/openai-quota.ts` |
| `src/lib/quota-monitor.ts` | `src/providers/quota/quota-monitor.ts` |
| `src/lib/ollama-cloud-probe.ts` | `src/providers/quota/ollama-cloud-probe.ts` |
| `src/lib/openai/index.ts` | `src/providers/compatibility/openai/index.ts` |
| `src/lib/glm-compat.ts` | `src/providers/compatibility/glm.ts` |
| `src/lib/messages-compat.ts` | `src/providers/compatibility/messages.ts` |
| `src/lib/responses-compat.ts` | `src/providers/compatibility/responses.ts` |
| `src/lib/ollama-compat.ts` | `src/providers/compatibility/ollama.ts` |
| `src/lib/ollama-context.ts` | `src/providers/compatibility/ollama-context.ts` |
| `src/lib/ollama-native.ts` | `src/providers/compatibility/ollama-native.ts` |
| `src/lib/embeddings-strategy.ts` | `src/providers/strategies/embeddings/legacy.ts` |
| `src/lib/embeddings-providers/*` | `src/providers/strategies/embeddings/providers/*` |
| `src/lib/request-auth.ts` | `src/tenants/auth/request-auth.ts` |
| `src/lib/native-auth.ts` | `src/tenants/auth/native-auth.ts` |
| `src/lib/auth/**` | `src/tenants/auth/**` |
| `src/lib/tenant-api-key.ts` | `src/tenants/api-keys/tenant-api-key.ts` |
| `src/lib/proxy-settings-store.ts` | `src/tenants/settings/proxy-settings-store.ts` |
| `src/lib/db/schema.ts` | `src/persistence/db/schema.ts` |
| `src/lib/db/index.ts` | `src/persistence/db/connection.ts` |
| `src/lib/db/sql-*.ts` | `src/persistence/stores/*.ts` unless observability-owned |
| `src/lib/db/account-health-store.ts` | `src/persistence/stores/account-health-store.ts` |
| `src/lib/db/event-store.ts` | `src/observability/events/event-store.ts` |
| `src/lib/db/event-labelers.ts` | `src/observability/events/event-labelers.ts` |
| `src/lib/federation/**` | `src/federation/**` |
| `src/lib/bridge-helpers.ts` | `src/federation/bridge/helpers.ts` |
| `src/lib/session-store.ts` | `src/sessions/session-store.ts` |
| `src/lib/chroma-session-index.ts` | `src/sessions/retrieval/chroma-session-index.ts` |
| `src/lib/chroma-ollama-embedding.ts` | `src/sessions/retrieval/chroma-ollama-embedding.ts` |
| `src/lib/request-log-store.ts` | `src/observability/request-log/store.ts` |
| `src/lib/observability/*` | `src/observability/request-log/*` |
| `src/lib/telemetry/*` | `src/observability/telemetry/*` |
| `src/lib/host-dashboard.ts` | `src/observability/dashboard/host-dashboard.ts` |

## Key Proxx domains and public concepts

### Application composition

Owns process wiring, dependency construction, and global config.

Public shapes:

- `ProxyConfig`
- `AppDeps`

Contract:

- app code wires domains together;
- app code should not contain provider/model policy;
- app dependency objects are explicit and readonly.

### HTTP edge and OpenAI-compatible surface

Owns route-level request parsing, response serialization, upstream header copying, stream handling, and OpenAI-compatible error envelopes.

Public concepts:

- request body parsers;
- OpenAI error response helpers;
- upstream header projection;
- SSE bridge utilities.

Contract:

- routes should call domain services;
- route files should not own SQL, credential rotation, or provider fallback loops;
- streaming is a first-class behavior, not incidental plumbing.

### Policy runtime boundary

Owns the TypeScript facade for CLJS runtime calls.

Public concepts:

- policy runtime loading;
- provider route retrieval;
- provider route filtering;
- model alias resolution;
- auto-model candidate resolution;
- queue policy execution.

Contract:

- TypeScript facade may normalize JS/CLJS shapes;
- semantic results must come from CLJS/EDN;
- failed/missing runtime behavior must be explicit: required, shadow, or fallback.

### Providers

Owns provider routes, accounts, credentials, provider catalogs, provider strategies, compatibility transforms, quotas, pricing, and provider execution.

Public shapes:

- `ProviderRoute`
- `ProviderCredential`
- `ProviderAuthType`
- `KeyPoolStatus`
- `ProviderStrategy`
- `UpstreamMode`
- `StrategyRequestContext`
- `ProviderAttemptContext`
- `ProviderAttemptOutcome`
- `ProviderRoutingExecutionResult`

Contract:

- provider strategies adapt wire protocols;
- provider routing execution consumes policy-selected candidates;
- provider strategy code must not become a global routing policy engine;
- credentials stay behind account/credential abstractions.

### Tenants and security

Owns auth resolution, tenant API keys, UI/native auth, GitHub allowlist, tenant settings, and tenant-provider policy.

Public concepts:

- request auth result;
- tenant API key lifecycle;
- provider policy share mode/trust tier;
- UI session projection.

Contract:

- routes get an authenticated subject or explicit unauthenticated state;
- tenant allow/deny behavior is policy-owned where semantic;
- tenant traffic must not learn internal account secrets or unapproved account IDs.

### Persistence

Owns SQL connection, schema/migrations, and durable store implementations.

Contract:

- `ALL_MIGRATIONS` plus `SCHEMA_VERSION` remain the migration source of truth;
- stores expose domain methods instead of leaking query constants across domains;
- relational schema supports operations and projection, not a second policy authority.

### Federation

Owns peer records, projected account records, bridge relay/agent/protocol, bridge request helpers, remote fetch, and on-demand projections.

Contract:

- federation is a transport/projection domain;
- bridge protocol shapes should be explicit;
- credential projection/import must stay behind tenant/federation authorization contracts.

### Observability

Owns request logs, event logs, event labeling, SSE/WS log hubs, telemetry, and host dashboard snapshots.

Contract:

- observability observes outcomes and emits projections;
- observability does not secretly influence routing except through explicit health/pheromone/policy inputs;
- event shapes should be append-friendly and projection-friendly.

### Sessions and retrieval

Owns chat session records, session search documents, Chroma indexing, and local embedding helpers.

Contract:

- session persistence is separate from provider execution;
- retrieval/indexing should consume session projections, not route internals.

## Knoxx structural guidelines to borrow

Knoxx has converged on a few useful rules that map well to Proxx.

### Vertical domain-driven slices

Knoxx prefers domain roots such as:

```text
knoxx.backend.domain/*
knoxx.backend.infra/*
knoxx.backend.shape/*
knoxx.backend.law/*
knoxx.backend.runtime/*
knoxx.backend.tools/*
```

For Proxx, the equivalent is:

```text
src/providers/*
src/tenants/*
src/federation/*
src/policy/*
src/observability/*
src/persistence/*
src/edge/*
src/support/*
```

### Shape and law split

Knoxx distinguishes:

- `shape.*`: data schemas, scalar predicates, parse/normalize helpers, non-throwing validators;
- `law.*`: invariants, authorization/admissibility checks, transition rules, policy checks.

For Proxx, use this distinction without necessarily copying the exact directory names everywhere:

```text
src/providers/routing/shapes.ts
src/providers/routing/laws.ts
src/tenants/provider-policy/shapes.ts
src/tenants/provider-policy/laws.ts
src/federation/bridge/shapes.ts
src/federation/bridge/laws.ts
```

or, for highly shared shapes:

```text
src/shape/scalar.ts
src/shape/http.ts
src/shape/provider.ts
src/law/authz.ts
src/law/provider-policy.ts
```

Keep the rule: shapes define what data is; laws define what data is allowed to do.

### Runtime means live process state only

Knoxx explicitly warns against hiding contract meaning in `runtime`. Proxx should do the same.

`runtime` may own:

- process-local caches;
- loaded CLJS runtime handle;
- boot lifecycle;
- mutable queues if unavoidable.

`runtime` must not own:

- policy meaning;
- model-family semantics;
- provider authorization semantics;
- account ordering rules.

### Contract-oriented backend

Knoxx treats contracts as first-class program inputs. Proxx already has this pattern through EDN policy contracts.

Proxx should make the contract boundary visible in source names:

```text
src/policy/cljs-runtime.ts
src/policy/policy-client.ts
src/policy/runtime-contracts.ts
resources/policies/runtime/*.edn
src/proxx/policy/**/*.cljs
```

### Spec size and migration discipline

Knoxx splits large work into small executable specs. Proxx should do the same for the source migration:

- no migration slice should exceed one coherent domain;
- low-risk support modules move first;
- high-inbound core files move after public APIs and shims exist;
- every move should run at least `pnpm build:ts` or an equivalent focused check.

## Functional TypeScript linting doctrine

The goal is not to cosplay Haskell in TypeScript. The goal is to make TypeScript assumptions closer to CLJS data assumptions:

- plain immutable data over mutable instances;
- pure transforms over hidden side effects;
- discriminated result maps over exception-shaped control flow where practical;
- explicit boundary parsers/normalizers;
- small functions and small modules;
- data-in/data-out APIs that can later be ported to CLJS with less conceptual drag.

### Preferred TypeScript style

Prefer:

```ts
type ProviderRoute = Readonly<{
  providerId: string;
  baseUrl: string;
  authRequired?: boolean;
  paths?: Readonly<Record<string, string>>;
}>;

type RouteDecision =
  | Readonly<{ status: "ok"; routes: readonly ProviderRoute[] }>
  | Readonly<{ status: "denied"; reason: string }>;

function normalizeProviderRoute(input: unknown): ProviderRoute | undefined {
  // parse unknown at the boundary, return data
}
```

Avoid for new code:

```ts
class MutableRouter {
  private routes: ProviderRoute[] = [];

  addRoute(route: ProviderRoute): void {
    this.routes.push(route);
  }
}
```

Classes remain acceptable for adapter objects with real lifecycle/state, especially stores, token refresh managers, and external service clients. They should be exceptions, not the default modeling tool.

### Linting stages

#### Stage 0: document and measure

Keep current lint thresholds, but add architecture rules and identify files that cannot yet comply.

Current known high-coupling files include:

- `src/lib/key-pool.ts`
- `src/lib/provider-strategy/shared.ts`
- `src/lib/config.ts`
- `src/lib/provider-routing.ts`
- `src/lib/request-log-store.ts`
- `src/lib/cljs-runtime.ts`

#### Stage 1: functional warnings for new/low-risk code

Use rules that do not require new dependencies:

```js
"prefer-const": "warn",
"no-var": "error",
"no-param-reassign": ["warn", { "props": true }],
"eqeqeq": ["error", "always"],
"no-else-return": "warn",
"object-shorthand": "warn",
"max-params": ["warn", 4]
```

Apply stricter function/file size thresholds to new target directories than to legacy `src/lib/**`.

Suggested first target override:

```js
{
  files: [
    "src/app/**/*.ts",
    "src/edge/**/*.ts",
    "src/policy/**/*.ts",
    "src/providers/**/*.ts",
    "src/tenants/**/*.ts",
    "src/federation/**/*.ts",
    "src/observability/**/*.ts",
    "src/persistence/**/*.ts",
    "src/sessions/**/*.ts",
    "src/support/**/*.ts"
  ],
  rules: {
    "complexity": ["warn", 12],
    "sonarjs/cognitive-complexity": ["warn", 18],
    "max-lines-per-function": ["warn", { "max": 60, "skipBlankLines": true, "skipComments": true }],
    "max-lines": ["warn", { "max": 300, "skipBlankLines": true, "skipComments": true }],
    "max-params": ["warn", 4],
    "no-param-reassign": ["warn", { "props": true }]
  }
}
```

#### Stage 2: type-aware readonly pressure

Enable a typed ESLint pass once the project can afford parser services in lint runtime.

Candidate rules:

```js
"@typescript-eslint/prefer-readonly": "warn",
"@typescript-eslint/prefer-readonly-parameter-types": "warn",
"@typescript-eslint/consistent-type-definitions": ["warn", "type"],
"@typescript-eslint/switch-exhaustiveness-check": "error"
```

Use overrides or gradual adoption. Existing store classes and Fastify route registrations will need exceptions.

#### Stage 3: functional plugin

Consider adding `eslint-plugin-functional` after Stage 1 has reduced obvious mutability.

Candidate starter rules:

```js
"functional/prefer-readonly-type": "warn",
"functional/immutable-data": ["warn", {
  "ignoreClasses": true,
  "ignoreAccessorPattern": ["module.exports", "exports.*"]
}],
"functional/no-let": "warn",
"functional/no-class": ["warn", { "allowConstructors": true }]
```

Do not enable `functional/no-expression-statements` globally. Proxx is an IO-heavy server; that rule belongs only in pure transform directories, if anywhere.

### Functional boundaries

Mark pure transform modules explicitly by location or naming:

```text
src/providers/compatibility/*
src/policy/*-normalization.ts
src/*/shapes.ts
src/*/laws.ts
```

For these modules, prefer stricter lint:

- no mutation;
- no classes;
- no hidden IO;
- exhaustive switches;
- readonly input/output types.

IO modules may remain effectful, but should isolate effects at their boundary:

```text
src/edge/**
src/persistence/**
src/providers/credentials/**
src/federation/bridge/**
```

## Dependency rules

```text
edge/routes
  may import: app public API, edge helpers, tenants auth, support
  must not import: provider strategy internals, raw SQL query constants

app
  may import: all domain public APIs
  owns: wiring only

policy
  may import: support
  must not import: routes or persistence implementation details

providers
  may import: policy client, tenant auth types, support, observability interfaces
  must not import: route implementation files

tenants
  may import: persistence store interfaces and support
  must not import: provider strategy internals

persistence
  may import: domain shapes and support
  must not import: app, edge routes, or provider execution internals

federation
  may import: provider public types, tenants auth types, support
  must not import: route implementation files

observability
  may import: public event/result shapes and support
  must not influence decisions except via explicit stores/inputs

support
  must not import: app, edge, providers, tenants, persistence, federation, or observability
```

## Migration plan

### Phase 1: establish target directories and shims

- Create target directories.
- Move low-risk support leaves first.
- Add temporary `src/lib/*` re-export shims where necessary.
- Keep behavior unchanged.

Best first moves:

```text
src/lib/http/*
src/lib/sse/*
src/lib/errors/*
src/lib/telemetry/*
src/lib/data/*
src/lib/openai/*
```

### Phase 2: isolate public APIs

Create public `index.ts` files for high-coupling domains:

```text
src/providers/index.ts
src/providers/routing/index.ts
src/providers/strategies/index.ts
src/policy/index.ts
src/persistence/index.ts
src/tenants/index.ts
src/observability/index.ts
```

Then update imports to use domain public APIs instead of deep legacy paths.

### Phase 3: move high-coupling core

Move only after public APIs and tests are stable:

```text
src/lib/key-pool.ts
src/lib/provider-routing.ts
src/lib/provider-strategy/shared.ts
src/lib/config.ts
src/lib/cljs-runtime.ts
src/lib/request-auth.ts
src/lib/db/schema.ts
```

### Phase 4: enforce lint by domain

- Keep legacy `src/lib/**` thresholds permissive while it shrinks.
- Make new domain directories stricter.
- Add type-aware/functional lint only after the first path migration proves lint runtime cost and false positives are manageable.

## Acceptance criteria

The architecture migration is working when:

1. New implementation code no longer lands in `src/lib/`.
2. Route files import domain facades, not deep provider/persistence internals.
3. Policy decisions still come from EDN/CLJS.
4. TypeScript pure modules are mostly data-in/data-out, readonly, and small.
5. `src/lib/` contains only compatibility shims or disappears.
6. Lint distinguishes legacy tolerance from new-domain expectations.
7. Build/test behavior remains stable after each migration slice.
