# Spec: request-log-store.ts Segmentation

## Problem Statement
`src/lib/request-log-store.ts` has:
- **Cyclomatic complexity: 61** in `sanitizeFederationUsageEntry` (but it's in ui-routes.ts)
- **Lines: 392** in `buildUsageOverviewFromEntries`
- **Lines: 373** in `buildUsageOverview`
- **Cognitive complexity: 56** in `buildUsageOverview`
- **File lines: 2533** (target: <800)
- **Exported functions: 40+** (CRUD, aggregation, hydration, metrics)

## Root Causes

### 1. Multiple Responsibilities
The file handles:
- **Storage**: SQLite CRUD operations
- **Hydration**: Loading data from disk into memory
- **Aggregation**: Computing usage statistics
- **Bucketing**: Time-series data organization
- **Health tracking**: Provider health metrics
- **Performance indexing**: Request latency analysis

### 2. Massive Hydration Functions
```typescript
function hydrateDb() { // 52+ lines
function hydrateEntry() { // 63 lines, complexity 25
function hydrateHourlyBucket() { // complexity 19
function hydrateDailyBucket() { // complexity 19
function hydrateDailyModelBucket() { // complexity 28
function hydrateDailyAccountBucket() { // complexity 32
```

### 3. Complex Update Logic
```typescript
function update() { // 67 lines, complexity 23
  // Multiple fields updated conditionally
  // Metric calculations inline
  // Event firing inline
}
```

### 4. Interleaved Read/Write Logic
Read operations (queries, filtering) mixed with write operations (recording, updating).

## Proposed Refactoring

### Phase 1: Extract Storage Layer (target: clear CRUD boundary)

#### 1.1 Create Repository Pattern
```typescript
// src/lib/request-log-store/repository.ts
export interface RequestLogRepository {
  create(entry: RequestLogEntry): Promise<void>;
  read(id: string): Promise<RequestLogEntry | undefined>;
  update(id: string, updates: Partial<RequestLogEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  query(filters: QueryFilters): Promise<RequestLogEntry[]>;
}

// src/lib/request-log-store/sqlite-repository.ts
export class SqliteRequestLogRepository implements RequestLogRepository {
  constructor(private readonly db: Database) {}
  
  async create(entry: RequestLogEntry): Promise<void> {
    // INSERT INTO request_logs ...
  }
  
  // ... other CRUD methods
}
```

#### 1.2 Extract Hydration Logic
```typescript
// src/lib/request-log-store/hydration.ts
export class RequestLogHydrator {
  constructor(private readonly repository: RequestLogRepository) {}
  
  async hydrateFull(): Promise<HydratedData> {
    const entries = await this.repository.query({});
    const buckets = this.computeBuckets(entries);
    return { entries, buckets };
  }
  
  private computeBuckets(entries: RequestLogEntry[]): BucketData {
    // Extracted from hydrateDailyBucket, etc.
  }
}
```

### Phase 2: Extract Aggregation Logic (target: clean separation)

#### 2.1 Create Aggregators
```typescript
// src/lib/request-log-store/aggregation/types.ts
export interface AggregationResult {
  byProvider: Map<string, ProviderMetrics>;
  byModel: Map<string, ModelMetrics>;
  byAccount: Map<string, AccountMetrics>;
  totals: AggregateTotals;
}

// src/lib/request-log-store/aggregation/usage-aggregator.ts
export class UsageAggregator {
  aggregate(entries: RequestLogEntry[], params: AggregationParams): AggregationResult {
    return {
      byProvider: this.aggregateByProvider(entries),
      byModel: this.aggregateByModel(entries),
      byAccount: this.aggregateByAccount(entries),
      totals: this.computeTotals(entries),
    };
  }
  
  private aggregateByProvider(entries: RequestLogEntry[]): Map<string, ProviderMetrics> {
    // Extracted from buildUsageOverviewFromEntries
  }
}
```

#### 2.2 Break Down Long Functions

**Before (392 lines):**
```typescript
async function buildUsageOverviewFromEntries(/* ... */) {
  // 50 lines: setup and parsing
  // 100 lines: provider aggregation
  // 80 lines: model aggregation  
  // 80 lines: account aggregation
  // 80 lines: response formatting
}
```

**After:**
```typescript
// src/lib/request-log-store/aggregation/overview-builder.ts
export class OverviewBuilder {
  build(entries: RequestLogEntry[], params: BuildParams): UsageOverview {
    const normalized = this.normalizeTimeRange(params);
    const filtered = this.filterByTime(entries, normalized);
    
    return {
      providers: this.aggregateProviders(filtered),
      models: this.aggregateModels(filtered),
      accounts: this.aggregateAccounts(filtered),
      totals: this.computeTotals(filtered),
      timeRange: normalized,
    };
  }
  
  private aggregateProviders(/* ... */): ProviderSummary[] { /* ~30 lines */ }
  private aggregateModels(/* ... */): ModelSummary[] { /* ~30 lines */ }
  private aggregateAccounts(/* ... */): AccountSummary[] { /* ~30 lines */ }
  private computeTotals(/* ... */): Totals { /* ~20 lines */ }
}
```

### Phase 3: Extract Bucketing (target: time-series separation)

#### 3.1 Create Bucket Manager
```typescript
// src/lib/request-log-store/buckets/types.ts
export interface TimeBucket {
  startMs: number;
  endMs: number;
  requestCount: number;
  totalTokens: number;
  // ...
}

// src/lib/request-log-store/buckets/bucket-manager.ts
export class BucketManager {
  private readonly hourlyBuckets = new Map<string, TimeBucket>();
  private readonly dailyBuckets = new Map<string, TimeBucket>();
  private readonly dailyModelBuckets = new Map<string, TimeBucket>();
  private readonly dailyAccountBuckets = new Map<string, TimeBucket>();
  
  addEntry(entry: RequestLogEntry): void {
    this.addToHourlyBucket(entry);
    this.addToDailyBucket(entry);
    this.addToModelBucket(entry);
    this.addToAccountBucket(entry);
  }
  
  snapshotHourly(since: number): HourlyBucket[] { /* ... */ }
  snapshotDaily(since: number): DailyBucket[] { /* ... */ }
}
```

### Phase 4: Extract Metrics (target: clean performance tracking)

```typescript
// src/lib/request-log-store/metrics/types.ts
export interface PerformanceMetrics {
  ewmaTtftMs: number;  // Time to first token
  ewmaTps: number;     // Tokens per second
  latencies: number[];
}

// src/lib/request-log-store/metrics/perf-index.ts
export class PerformanceIndex {
  private readonly providerMetrics = new Map<string, ProviderPerf>();
  
  update(entry: RequestLogEntry): void {
    const key = `${entry.providerId}:${entry.accountId}:${entry.model}`;
    const perf = this.providerMetrics.get(key) ?? this.createPerf(key);
    perf.update(entry);
    this.providerMetrics.set(key, perf);
  }
  
  getSummary(provider: string, account: string, model: string): PerformanceMetrics | undefined {
    return this.providerMetrics.get(`${provider}:${account}:${model}`);
  }
}
```

## File Structure After Refactoring

```
src/lib/request-log-store/
├── index.ts                           # Public API (~80 lines)
├── types.ts                           # All exported types (~150 lines)
├── repository/
│   ├── types.ts                       # Repository interfaces
│   ├── sqlite-repository.ts           # SQLite implementation (~200 lines)
│   └── index.ts                       # Repository exports
├── hydration/
│   ├── hydrator.ts                    # Main hydration logic (~100 lines)
│   ├── bucket-hydrator.ts             # Bucket hydration (~80 lines)
│   └── index.ts                       # Hydration exports
├── aggregation/
│   ├── types.ts                       # Aggregation types
│   ├── usage-aggregator.ts            # Usage aggregation (~150 lines)
│   ├── overview-builder.ts            # Overview building (~120 lines)
│   └── index.ts                       # Aggregation exports
├── buckets/
│   ├── types.ts                       # Bucket types
│   ├── bucket-manager.ts              # Bucket management (~150 lines)
│   └── index.ts                       # Bucket exports
├── metrics/
│   ├── types.ts                       # Metrics types
│   ├── perf-index.ts                  # Performance indexing (~100 lines)
│   └── index.ts                       # Metrics exports
└── request-log-store.ts               # Main class (~200 lines)
```

## Migration Plan

### Step 1: Extract Types (1 day)
- [ ] Create `src/lib/request-log-store/types.ts`
- [ ] Move all interfaces and type definitions
- [ ] Update imports in main file
- [ ] Verify compilation

### Step 2: Extract Repository (2 days)
- [ ] Create `repository/types.ts` with `RequestLogRepository` interface
- [ ] Create `repository/sqlite-repository.ts` with SQLite implementation
- [ ] Extract CRUD logic from main class
- [ ] Add repository unit tests
- [ ] Wire into main class

### Step 3: Extract Hydration (2 days)
- [ ] Create `hydration/hydrator.ts`
- [ ] Extract `hydrateDb`, `hydrateEntry`, etc.
- [ ] Extract bucket hydration to `hydration/bucket-hydrator.ts`
- [ ] Add hydration tests
- [ ] Wire into main class

### Step 4: Extract Aggregation (2 days)
- [ ] Create `aggregation/types.ts` with aggregation types
- [ ] Create `aggregation/usage-aggregator.ts`
- [ ] Break down `buildUsageOverviewFromEntries` into methods
- [ ] Create `aggregation/overview-builder.ts`
- [ ] Add aggregation tests
- [ ] Wire into main class

### Step 5: Extract Buckets (2 days)
- [ ] Create `buckets/types.ts`
- [ ] Create `buckets/bucket-manager.ts`
- [ ] Extract bucket management logic
- [ ] Add bucket tests
- [ ] Wire into main class

### Step 6: Extract Metrics (1 day)
- [ ] Create `metrics/types.ts`
- [ ] Create `metrics/perf-index.ts`
- [ ] Extract performance index logic
- [ ] Add metrics tests

### Step 7: Final Integration (1 day)
- [ ] Update main `RequestLogStore` class to use extracted modules
- [ ] Remove inline implementations
- [ ] Update public API exports
- [ ] Full test suite verification

## Success Criteria

| Metric | Before | After Each Phase | Final Target |
|--------|--------|------------------|--------------|
| File lines (request-log-store.ts) | 2533 | P1: 1800, P2: 1200, P3: 600 | <500 |
| `buildUsageOverviewFromEntries` lines | 392 | P1: 200, P2: 120, P3: 80 | <80 |
| `buildUsageOverview` lines | 373 | P1: 200, P2: 100, P3: 60 | <60 |
| `buildUsageOverview` cognitive | 56 | P1: 30, P2: 20, P3: 15 | <15 |
| Domain modules | 0 | P1: 2, P2: 4, P3: 6 | 6 |

## Risk Mitigation

### SQLite Transaction Boundaries
Current code uses synchronous SQLite; hydration may span multiple transactions.

**Mitigation:** Repository pattern encapsulates transactions; hydration called atomically.

### Memory Pressure
Hydration loads full dataset into memory.

**Mitigation:** Bucket manager already handles this; aggregation can be lazy-loaded.

### API Compatibility
`RequestLogStore` has many public methods.

**Mitigation:** Keep `RequestLogStore` class as façade delegating to modules:
```typescript
export class RequestLogStore implements RequestLogRepository {
  constructor(
    private readonly repository: RequestLogRepository,
    private readonly hydrator: RequestLogHydrator,
    private readonly aggregator: UsageAggregator,
    private readonly buckets: BucketManager,
    private readonly metrics: PerformanceIndex,
  ) {}
  
  // Public API methods delegate to modules
  record(entry: Entry): string {
    this.repository.create(entry);
    this.buckets.addEntry(entry);
    this.metrics.update(entry);
    return entry.id;
  }
}
```

## Rollback Plan
- Each extraction is a separate PR
- Main class continues to provide public API
- Modules can be re-inlined if needed
- Feature flag `USE_MODULAR_REQUEST_LOG_STORE` controls migration