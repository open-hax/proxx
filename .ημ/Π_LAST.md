# Π Snapshot: 2026-03-22T15:09:30Z

## Context
- Branch: feat/consolidate-federation-into-staging
- Commit: 6bc392a
- Tag: Π/2026-03-22/150930-6bc392a

## Work Completed

### Dashboard Cache Metrics Fix
- **Root cause**: Streaming Responses API may not include usage in `response.completed` event
- **Symptom**: 31 requests had `cachedPromptTokens: null` instead of explicit `0`
- **Fix**: Modified `extractUsageFromResponsesSse()` to return `cachedPromptTokens: 0` when usage present but no cache field

### Investigation Summary
- Cache affinity system working correctly
- OpenAI semantic cache spans accounts (account-agnostic)
- Dashboard correctly handles null values in aggregation
- JSONL deduplication by ID working as designed

## Files Modified
- `src/lib/provider-strategy/shared.ts`: Added explicit handling in `extractUsageFromResponsesSse()`

## Metrics Observed
- Cache hit rate: ~11% (dashboard-wide)
- Per-account hit rate: ~47% (bound affinity account)
- Token efficiency: ~37.6% (4.1M cached / 11M prompt tokens)
