# Master Spec: Lint Complexity Reduction

## Context
The codebase has accumulated significant technical debt in the form of complex, long functions that exceed reasonable maintainability thresholds. The current error-level thresholds had to be raised to 154 (complexity), 400 (cognitive), and 2400 (lines) just to pass CI.

## Current State (2026-03-23)

| Metric | Threshold | Worst Value | File |
|--------|-----------|-------------|------|
| Cyclomatic Complexity | 10 (warn) | 154 | `fallback.ts` |
| Cognitive Complexity | 15 (warn) | 399 | `fallback.ts` |
| Lines per Function | 50 (warn) | 2337 | `app.ts` (`createApp`) |
| File Lines | 300 (warn) | 4137 | `ui-routes.ts` |

## Target State
Bring all complexity metrics below error thresholds (currently set very high) and establish a path to sustainable thresholds:

| Metric | Phase 1 Target | Phase 2 Target | Ideal |
|---------|----------------|----------------|-------|
| Cyclomatic Complexity | <100 | <50 | <20 |
| Cognitive Complexity | <200 | <100 | <30 |
| Lines per Function | <500 | <200 | <80 |

## Phased Approach

### Phase 1: Extraction & Delegation (2-3 weeks)
Split monolithic functions into focused, single-responsibility modules while maintaining current behavior. Target: reduce worst offenders by 50%.

**Priority Order:**
1. **fallback.ts** - Worst offender (complexity 154, cognitive 399, lines 663)
2. **app.ts** - Largest lines (2337 in createApp)
3. **ui-routes.ts** - Second largest file (4137 lines, 1601 lines in registerUiRoutes)
4. **responses-compat.ts** - High cognitive (113) and complexity (67)
5. **shared.ts** - Moderate issues (cognitive 55, complexity issues)
6. **request-log-store.ts** - Moderate issues (lines 392, complexity 61)

### Phase 2: Consolidation & Simplification (2-3 weeks)
Apply guard clauses, early returns, and strategy pattern to reduce branching. Target: all metrics under Phase 2 thresholds.

### Phase 3: Sustainable Practices (ongoing)
- Add complexity gates to CI that block PRs with new complexity debt
- Establish code review checklist for complexity
- Monthly complexity trend reporting

## Spec Files

1. [fallback-extraction.spec.md](./fallback-extraction.spec.md) - Extract `executeProviderFallback` into strategy-specific handlers
2. [app-modularization.spec.md](./app-modularization.spec.md) - Split `createApp` into route registration modules
3. [ui-routes-flattening.spec.md](./ui-routes-flattening.spec.md) - Flatten `registerUiRoutes` into focused route groups
4. [responses-stream-refactor.spec.md](./responses-stream-refactor.spec.md) - Simplify SSE stream processing in `processEvent`
5. [shared-utilities-split.spec.md](./shared-utilities-split.spec.md) - Split shared utilities into domain-specific modules
6. [request-log-segmentation.spec.md](./request-log-segmentation.spec.md) - Separate storage, hydration, and aggregation logic

## Success Metrics

### Quantitative
- [ ] All files pass `complexity < 100`
- [ ] All files pass `cognitive-complexity < 200`
- [ ] No function exceeds 500 lines
- [ ] Test coverage remains ≥90% for refactored modules

### Qualitative
- [ ] Each exported function has a single, clear responsibility
- [ ] No nested conditionals deeper than 3 levels
- [ ] All `if` branches have corresponding early-return alternatives
- [ ] Strategy pattern replaces large `switch` statements

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Behavior drift during extraction | Comprehensive test coverage before refactor; snapshot testing for edge cases |
| Performance regression | Benchmark before/after for hot paths; maintain A/B capability during migration |
| Scope creep | Strict per-spec success criteria; no speculative changes |
| Merge conflicts | Work on independent files; coordinate shared.ts changes last |

## References
- [ESLint Complexity Rule](https://eslint.org/docs/latest/rules/complexity)
- [SonarJS Cognitive Complexity](https://github.com/SonarSource/eslint-plugin-sonarjs/blob/master/docs/rules/cognitive-complexity.md)
- [Refactoring: Improving the Design of Existing Code](https://martinfowler.com/books/refactoring.html)