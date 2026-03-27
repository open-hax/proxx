# Legacy `/api/ui/*` deprecation plan

## Status
Draft

## Summary
Turn `/api/ui/*` from the accidental canonical operator API into an explicit compatibility layer, then remove it only after `/api/v1/*` reaches endpoint parity and all primary callsites are migrated.

This spec exists to prevent the transition from stalling halfway, with both route families treated as primary forever.

## Source specs
- `specs/drafts/control-plane-mvc-transition-roadmap.md`
- `specs/drafts/control-plane-api-contract-v1.md`
- all control-plane slice specs in this transition stack

## Problem statement
Today `/api/ui/*` is both:

- the real operator API used by the frontend
- the registration surface owned by `src/lib/ui-routes.ts`

If the migration only adds `/api/v1/*` without a deprecation plan, the repo will keep two primary control-plane APIs indefinitely.

## Goals
1. Make `/api/v1/*` the only canonical control-plane API.
2. Keep `/api/ui/*` temporarily for compatibility.
3. Provide clear removal gates for `src/lib/ui-routes.ts`.
4. Ensure route aliases never diverge from canonical behavior.

## Non-goals
- immediate hard removal of `/api/ui/*`
- breaking old clients without a transition period
- changing `/v1/*` data-plane paths

## Compatibility policy

### Canonical
- `/api/v1/*`

### Legacy alias
- `/api/ui/*`

Legacy alias requirements:
- same controller/service path as canonical route
- same status code and response body shape unless explicitly documented otherwise
- same authorization semantics

## Suggested deprecation signaling
When feasible, legacy alias responses should include deprecation metadata such as:

- `Deprecation: true`
- `Link: </api/v1/...>; rel="successor-version"`
- optional `Sunset` header once a removal date is known

If headers are too noisy during early migration, at minimum document the deprecation in the API spec and repository docs.

## Phases

### Phase A: central aliasing model
- stop treating `/api/ui/*` as the primary implementation site
- wire legacy paths to the same controller/service path as `/api/v1/*`
- avoid copy-paste route logic

### Phase B: deprecation visibility
- add docs noting `/api/ui/*` is legacy
- add deprecation headers or equivalent signaling where practical
- ensure `/api/v1/*` is documented in frontend and OpenAPI references as canonical

### Phase C: callsite migration
- update `web/src/lib/api.ts` to use `/api/v1/*` exclusively for control-plane calls
- update tests to exercise canonical routes first, with alias parity coverage where needed
- remove direct imports that anchor new code to `src/lib/ui-routes.ts`

### Phase D: shim shrink and removal
- reduce `src/lib/ui-routes.ts` to a minimal compatibility shim or route re-export
- once callsites and tests are migrated, delete the shim and remove `/api/ui/*` routes if desired
- if removal is deferred, keep `/api/ui/*` as a documented compatibility layer with zero unique logic

## Removal gates
Do not remove the legacy layer until all of the following are true:

1. all control-plane slices have canonical `/api/v1/*` coverage
2. frontend uses `/api/v1/*` only
3. tests no longer rely on `/api/ui/*` as the primary contract
4. `src/lib/ui-routes.ts` contains no unique business logic
5. parity tests confirm alias behavior during the overlap period

## Verification
- grep/search confirms frontend callsites no longer target `/api/ui/*`
- grep/search confirms new route modules no longer depend on `src/lib/ui-routes.ts`
- parity tests confirm old and new routes behave identically during overlap
- docs and OpenAPI references name `/api/v1/*` as canonical

## Risks
- alias drift if old and new routes are implemented separately
- removal blocked indefinitely if no explicit gates exist
- silent client breakage if deprecation is announced without parity coverage

## Definition of done
- `/api/ui/*` is explicitly legacy, not implicit primary
- `/api/v1/*` is the canonical control-plane API everywhere
- `src/lib/ui-routes.ts` is either a zero-logic shim or removed
- the repository is no longer architecturally anchored on the legacy route file
