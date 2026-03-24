# Spec: ui-routes.ts Flattening

## Problem Statement
`registerUiRoutes` in `src/lib/ui-routes.ts` has:
- **Lines: 1601** (target: <200)
- **Cognitive complexity: 56** (target: <30)
- **File lines: 4137** (target: <1000)

The file also has:
- `sanitizeFederationUsageEntry` with complexity 61
- `buildUsageOverviewFromEntries` with 392 lines
- `buildUsageOverview` with 373 lines, cognitive 56

## Root Causes

### 1. God Function Anti-Pattern
`registerUiRoutes` registers 50+ routes in one function:
- `/ui` - static file serving
- `/api/ui/usage` - usage overview
- `/api/ui/credentials` - credential management
- `/api/ui/hosts` - host management
- `/api/ui/models` - model catalog
- `/api/ui/federation/*` - federation routes
- `/api/ui/analytics/*` - analytics routes
- WebSocket routes
- And many more...

### 2. Inline Aggregation Logic
Complex data aggregation happens inline in route handlers:
```typescript
app.get('/api/ui/usage', async (request, reply) => {
  const allLogs = requestLogStore.snapshot();
  // 100+ lines of filtering, aggregation, grouping
  // Another 50+ lines of response formatting
});
```

### 3. Repeated Patterns
Similar validation, error handling, and response formatting repeated across routes.

## Proposed Refactoring

### Phase 1: Extract Route Groups (target: lines <600)

#### 1.1 Create Route Group Modules
```typescript
// src/routes/ui/types.ts
export interface UIRouteGroup {
  prefix: string;
  register(app: FastifyInstance, deps: UIRouteDependencies): Promise<void>;
}
```

#### 1.2 Extract Usage Routes
```typescript
// src/routes/ui/usage.ts
export const usageRoutes: UIRouteGroup = {
  prefix: '/api/ui',
  async register(app, deps) {
    app.get('/usage', { schema: usageSchema }, handleUsageRequest(deps));
    app.get('/usage/hourly', { schema: hourlySchema }, handleHourlyUsage(deps));
    app.get('/usage/daily', { schema: dailySchema }, handleDailyUsage(deps));
  }
};

// src/handlers/ui/usage.ts
export function handleUsageRequest(deps: UIRouteDependencies) {
  return async (request, reply) => {
    const params = parseUsageQuery(request);
    const data = await deps.usageService.getOverview(params);
    return reply.send(data);
  };
}
```

#### 1.3 Extract Credential Routes
```typescript
// src/routes/ui/credentials.ts
export const credentialsRoutes: UIRouteGroup = {
  prefix: '/api/ui',
  async register(app, deps) {
    app.get('/credentials', handleListCredentials(deps));
    app.post('/credentials', handleCreateCredential(deps));
    app.put('/credentials/:id', handleUpdateCredential(deps));
    app.delete('/credentials/:id', handleDeleteCredential(deps));
  }
};
```

#### 1.4 Extract Federation Routes
```typescript
// src/routes/ui/federation.ts
export const federationRoutes: UIRouteGroup = {
  prefix: '/api/ui/federation',
  async register(app, deps) {
    app.get('/peers', handleListPeers(deps));
    app.post('/peers', handleCreatePeer(deps));
    // ... other federation routes
  }
};
```

### Phase 2: Extract Services (target: lines <400)

#### 2.1 Usage Service
```typescript
// src/services/usage-service.ts
export class UsageService {
  constructor(private readonly requestLogStore: RequestLogStore) {}

  async getOverview(params: UsageQueryParams): Promise<UsageOverview> {
    const logs = this.requestLogStore.snapshot();
    return this.aggregateOverview(logs, params);
  }

  async getHourlyData(params: UsageQueryParams): Promise<HourlyBucket[]> {
    // ...
  }

  private aggregateOverview(logs: RequestLogEntry[], params: UsageQueryParams): UsageOverview {
    // Extracted from buildUsageOverviewFromEntries
  }
}
```

#### 2.2 Federation Service
```typescript
// src/services/federation-service.ts
export class FederationService {
  constructor(
    private readonly federationStore: FederationStore,
    private readonly requestLogStore: RequestLogStore,
  ) {}

  async getPeerStatus(peerId: string): Promise<PeerStatus> { ... }
  async listPeers(): Promise<PeerSummary[]> { ... }
  // ...
}
```

### Phase 3: Reduce Function Sizes (target: lines <200)

#### 3.1 Break Down `buildUsageOverviewFromEntries`
Current: 392 lines
Target: 4 functions of ~50 lines each

```typescript
// src/services/usage/aggregation.ts
export function aggregateOverview(entries: RequestLogEntry[], params: AggregationParams): UsageOverview {
  const byProvider = groupByProvider(entries);
  const byModel = groupByModel(entries);
  const byAccount = groupByAccount(entries);
  const totals = calculateTotals([byProvider, byModel, byAccount]);
  
  return {
    providers: summarizeGroups(byProvider),
    models: summarizeGroups(byModel),
    accounts: summarizeGroups(byAccount),
    totals,
    timeRange: params.timeRange,
  };
}
```

#### 3.2 Break Down `sanitizeFederationUsageEntry`
Current: complexity 61
Target: complexity <20

```typescript
// src/services/federation/sanitize.ts
export function sanitizeFederationUsageEntry(entry: FederationEntry): SanitizedEntry {
  return {
    peer: sanitizePeer(entry.peer),
    accounts: entry.accounts.map(sanitizeAccount),
    usage: sanitizeUsage(entry.usage),
    health: sanitizeHealth(entry.health),
  };
}

function sanitizePeer(peer: PeerInfo): SanitizedPeer { ... }
function sanitizeAccount(account: AccountInfo): SanitizedAccount { ... }
function sanitizeUsage(usage: UsageInfo): SanitizedUsage { ... }
function sanitizeHealth(health: HealthInfo): SanitizedHealth { ... }
```

## File Structure After Refactoring

```
src/
├── routes/
│   └── ui/
│       ├── types.ts                 # UIRouteGroup, dependencies
│       ├── index.ts                 # Exports all route groups
│       ├── usage.ts                 # Usage routes (~50 lines)
│       ├── credentials.ts           # Credential routes (~80 lines)
│       ├── federation.ts            # Federation routes (~100 lines)
│       ├── analytics.ts             # Analytics routes (~100 lines)
│       ├── hosts.ts                 # Host management routes
│       └── models.ts                 # Model catalog routes
├── handlers/
│   └── ui/
│       ├── usage.ts                 # Usage handlers (~50 lines each)
│       ├── credentials.ts           # Credential handlers
│       ├── federation.ts            # Federation handlers
│       └── analytics.ts             # Analytics handlers
├── services/
│   ├── usage-service.ts             # Usage aggregation
│   ├── federation-service.ts        # Federation operations
│   └── analytics-service.ts          # Analytics calculations
└── lib/
    └── (existing) - refactor registerUiRoutes to orchestrate modules
```

## Migration Plan

### Step 1: Create Infrastructure (1 day)
- [ ] Create `src/routes/ui/types.ts`
- [ ] Create `src/services/usage-service.ts` stub
- [ ] Create feature flag `USE_MODULAR_UI_ROUTES`

### Step 2: Extract Usage Routes (2 days)
- [ ] Create `src/routes/ui/usage.ts`
- [ ] Create `src/handlers/ui/usage.ts`
- [ ] Move aggregation logic to `UsageService`
- [ ] Break down `buildUsageOverviewFromEntries` into 4 functions
- [ ] Wire into `registerUiRoutes` behind feature flag
- [ ] Integration tests

### Step 3: Extract Credential Routes (2 days)
- [ ] Create `src/routes/ui/credentials.ts`
- [ ] Create `src/handlers/ui/credentials.ts`
- [ ] Extract credential formatting/validation logic
- [ ] Integration tests

### Step 4: Extract Federation Routes (2 days)
- [ ] Create `src/routes/ui/federation.ts`
- [ ] Create `src/handlers/ui/federation.ts`
- [ ] Break down `sanitizeFederationUsageEntry`
- [ ] Integration tests

### Step 5: Extract Analytics Routes (2 days)
- [ ] Create `src/routes/ui/analytics.ts`
- [ ] Create `src/handlers/ui/analytics.ts`
- [ ] Break down `buildUsageOverview`
- [ ] Integration tests

### Step 6: Final Integration (1 day)
- [ ] Replace `registerUiRoutes` with module-based registration
- [ ] Remove feature flag
- [ ] Clean up old inline handlers
- [ ] Full regression test

## Success Criteria

| Metric | Before | After Each Phase | Final Target |
|--------|--------|------------------|--------------|
| `registerUiRoutes` lines | 1601 | P1: 600, P2: 300, P3: 100 | <100 |
| File lines (ui-routes.ts) | 4137 | P1: 2000, P2: 1000, P3: 500 | <500 |
| `buildUsageOverviewFromEntries` lines | 392 | P1: 200, P2: 100, P3: 50 | <50 |
| `sanitizeFederationUsageEntry` complexity | 61 | P1: 30, P2: 20, P3: 15 | <15 |
| Route modules created | 0 | P1: 2, P2: 4, P3: 6+ | 6+ |

## Risk Mitigation

### Route Order Dependencies
Some routes may depend on registration order (e.g., static files vs API routes).

**Mitigation:** Explicit priority ordering in route groups:
```typescript
export interface UIRouteGroup {
  priority: number; // Lower = earlier
  // ...
}
```

### Shared State Between Routes
Routes currently share closures over `keyPool`, `requestLogStore`, etc.

**Mitigation:** Explicit dependency injection:
```typescript
export interface UIRouteDependencies {
  keyPool: KeyPool;
  requestLogStore: RequestLogStore;
  federationStore: FederationStore;
  // ...
}
```

### Response Format Compatibility
Clients expect specific response shapes.

**Mitigation:** Create response type definitions and use schema validation:
```typescript
export const usageOverviewSchema = {
  response: {
    type: 'object',
    properties: {
      providers: { type: 'array' },
      models: { type: 'array' },
      // ...
    }
  }
};
```

## Rollback Plan
- Feature flag `USE_MODULAR_UI_ROUTES` allows instant switch back
- Old routes preserved behind flag
- Response-compatibility tests compare both implementations