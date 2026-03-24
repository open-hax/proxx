# Lint Complexity Reduction Specs

## Overview
This directory contains detailed specifications for reducing code complexity across the proxx codebase. Each spec targets a specific worst-offender file and provides a phased refactoring plan.

## Priority Matrix

| File | Complexity | Cognitive | Lines (func) | Lines (file) | Priority |
|------|------------|-----------|--------------|--------------|----------|
| `fallback.ts` | 154 | 399 | 663 | 886 | **P0** |
| `app.ts` | — | 59 | 2337 | 3048 | **P0** |
| `ui-routes.ts` | 61 | 56 | 1601 | 4137 | **P1** |
| `responses-compat.ts` | 67 | 113 | — | 1514 | **P1** |
| `request-log-store.ts` | 61 | — | 392 | 2533 | **P2** |
| `shared.ts` | — | 55 | — | 1643 | **P2** |

## Specs

### P0: Critical Priority

1. **[fallback-extraction.spec.md](./fallback-extraction.spec.md)**
   - Target: `src/lib/provider-strategy/fallback.ts`
   - Worst offender: complexity 154, cognitive 399
   - Approach: Extract orchestrator, credential selector, response handler, error classifier
   - Duration: ~10 days

2. **[app-modularization.spec.md](./app-modularization.spec.md)**
   - Target: `src/app.ts`
   - Largest function: `createApp` at 2337 lines
   - Approach: Route modules, handler extraction, factory pattern
   - Duration: ~10 days

### P1: High Priority

3. **[ui-routes-flattening.spec.md](./ui-routes-flattening.spec.md)**
   - Target: `src/lib/ui-routes.ts`
   - Largest: `registerUiRoutes` at 1601 lines
   - Approach: Route groups, service extraction, handler modules
   - Duration: ~12 days

4. **[responses-stream-refactor.spec.md](./responses-stream-refactor.spec.md)**
   - Target: `src/lib/responses-compat.ts`
   - Complex: `processEvent` with complexity 67, cognitive 113
   - Approach: Event handler registry, state machine, converter modules
   - Duration: ~7 days

### P2: Medium Priority

5. **[shared-utilities-split.spec.md](./shared-utilities-split.spec.md)**
   - Target: `src/lib/provider-strategy/shared.ts`
   - Mixed domain concerns across 1643 lines
   - Approach: Domain module separation, diagnostics extraction
   - Duration: ~8 days

6. **[request-log-segmentation.spec.md](./request-log-segmentation.spec.md)**
   - Target: `src/lib/request-log-store.ts`
   - Mixed storage/hydration/aggregation in 2533 lines
   - Approach: Repository pattern, hydration extraction, aggregator classes
   - Duration: ~11 days

## Master Spec

See **[MASTER.lint-complexity-reduction.spec.md](./MASTER.lint-complexity-reduction.spec.md)** for:
- Current state metrics
- Target thresholds
- Phased approach timeline
- Risk mitigation strategies
- Success criteria

## Execution Order

```
Week 1-2:  Phase 1 of fallback.ts (extract handlers, error classifier)
Week 2-3:  Phase 1 of app.ts (extract route modules)
Week 3-4:  Phase 1 of ui-routes.ts (extract route groups)
Week 4-5:  Phase 1 of responses-compat.ts (handler registry)
Week 5-6:  Phase 1 of shared.ts (domain modules)
Week 6-7:  Phase 1 of request-log-store.ts (repository extraction)
Week 7-8:  Phase 2 of all files (simplify, early returns)
Week 8-10: Phase 3 of all files (final cleanup)
```

## Tracking

After merging specs, create tracking issues for each:
- [ ] Create tracking issue for fallback-extraction
- [ ] Create tracking issue for app-modularization
- [ ] Create tracking issue for ui-routes-flattening
- [ ] Create tracking issue for responses-stream-refactor
- [ ] Create tracking issue for shared-utilities-split
- [ ] Create tracking issue for request-log-segmentation

## Notes

- Each spec is designed to be executed independently
- Feature flags allow incremental rollout
- Tests should pass after each phase
- Complexity metrics should be tracked in CI