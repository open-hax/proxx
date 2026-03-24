# Spec: app.ts Modularization

## Problem Statement
`createApp` in `src/app.ts` has:
- **Lines: 2337** (target: <200)
- **Cognitive complexity: 59** (target: <30)
- **File lines: 3048** (target: <800)

The function registers all routes, middleware, and handlers in one monolithic block.

## Root Causes

### 1. Single Registration Point
All route registration happens in `createApp`:
- Health routes (`/health`, `/ ready`)
- Proxy routes (`/v1/*`)
- Federation routes (`/federation/*`)
- UI routes (`/ui/*`, `/api/ui/*`)
- Admin routes
- WebSocket routes
- Static file serving

### 2. Inline Handler Definitions
Handlers are defined inline with arrow functions:
```typescript
app.post('/v1/chat/completions', async (request, reply) => {
  // 50+ lines of handler logic
});

app.get('/ui/usage', async (request, reply) => {
  // 100+ lines of handler logic
});
```

### 3. Configuration Logic Inline
Feature flags, CORS, auth middleware setup all inline:
```typescript
if (config.enableFederation) {
  app.register(federationPlugin, ...);
}
if (config.enableUi) {
  await registerUiRoutes(app, ...);
}
// etc.
```

## Proposed Refactoring

### Phase 1: Extract Route Modules (target: lines <800)

#### 1.1 Create Route Registry Pattern
```typescript
// src/routes/types.ts
export interface RouteModule {
  readonly name: string;
  readonly version?: string;
  register(app: FastifyInstance, config: ProxyConfig): Promise<void> | void;
}
```

#### 1.2 Extract Health Routes
```typescript
// src/routes/health.ts
import type { RouteModule } from './types.js';
import type { ProxyConfig } from '../lib/config.js';

export const healthRoutes: RouteModule = {
  name: 'health',
  register(app, config) {
    app.get('/health', async (request, reply) => {
      return { status: 'ok', version: config.version };
    });
    
    app.get('/ready', async (request, reply) => {
      // readiness check
    });
  }
};
```

#### 1.3 Extract Proxy Routes
```typescript
// src/routes/proxy.ts
export const proxyRoutes: RouteModule = {
  name: 'proxy',
  register(app, config) {
    app.register(proxyPlugin, { config });
  }
};
```

#### 1.4 Extract UI Routes (already extracted to ui-routes.ts)
Move `registerUiRoutes` call into proper route module.

#### 1.5 Extract Federation Routes
```typescript
// src/routes/federation.ts
export const federationRoutes: RouteModule = {
  name: 'federation',
  async register(app, config) {
    if (!config.enableFederation) return;
    
    app.register(federationPlugin, { config });
    // ... federation-specific routes
  }
};
```

### Phase 2: Extract Handlers (target: lines <500)

Move inline handlers to dedicated files:

```typescript
// src/handlers/chat-completions.ts
export async function handleChatCompletions(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HandlerDependencies
): Promise<void> {
  // handler logic
}

// src/handlers/usage.ts
export async function handleUsageRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: HandlerDependencies
): Promise<void> {
  // handler logic
}
```

### Phase 3: Factory Pattern (target: lines <300)

```typescript
// src/app.ts (simplified)
export async function createApp(config: ProxyConfig): Promise<FastifyInstance> {
  const app = fastify({ ... });
  
  // Register core middleware
  await registerCoreMiddleware(app, config);
  
  // Register routes via modules
  const routeModules: RouteModule[] = [
    healthRoutes,
    proxyRoutes,
    ...config.enableFederation ? [federationRoutes] : [],
    ...config.enableUi ? [uiRoutes] : [],
  ];
  
  for (const module of routeModules) {
    await module.register(app, config);
  }
  
  await app.ready();
  return app;
}
```

## File Structure After Refactoring

```
src/
├── app.ts                           # createApp factory (~150 lines)
├── middleware/
│   ├── auth.ts                      # Authentication middleware
│   ├── cors.ts                      # CORS configuration
│   ├── logging.ts                   # Request logging
│   └── error-handler.ts             # Global error handler
├── routes/
│   ├── types.ts                     # RouteModule interface
│   ├── index.ts                     # All route exports
│   ├── health.ts                    # Health/ready routes
│   ├── proxy.ts                     # /v1/* routes
│   ├── federation.ts                # Federation routes
│   ├── ui.ts                        # UI routes (import from ui-routes.ts)
│   └── admin.ts                     # Admin routes
├── handlers/
│   ├── chat-completions.ts          # POST /v1/chat/completions
│   ├── embeddings.ts                # POST /v1/embeddings
│   ├── models.ts                    # GET /v1/models
│   ├── usage.ts                     # GET /api/ui/usage
│   └── credentials.ts               # Credential management
└── lib/
    └── (existing shared utilities)
```

## Migration Plan

### Step 1: Create Route Module Infrastructure (1 day)
- [ ] Create `src/routes/types.ts` with `RouteModule` interface
- [ ] Create `src/routes/index.ts` for exports
- [ ] Create empty `src/routes/health.ts` as template

### Step 2: Extract Health Routes (1 day)
- [ ] Move `/health` and `/ready` handlers to `health.ts`
- [ ] Update `createApp` to use `healthRoutes.register(app, config)`
- [ ] Verify health endpoints still work

### Step 3: Extract Proxy Routes (2 days)
- [ ] Move proxy plugin registration to `proxy.ts`
- [ ] Extract `/v1/chat/completions` handler to `handlers/chat-completions.ts`
- [ ] Extract `/v1/models` handler
- [ ] Extract `/v1/embeddings` handler
- [ ] Integration tests for proxy routes

### Step 4: Extract Federation Routes (2 days)
- [ ] Move federation logic to `federation.ts`
- [ ] Handle conditional registration based on `config.enableFederation`
- [ ] Integration tests for federation routes

### Step 5: Extract Admin/Config Routes (1 day)
- [ ] Move admin routes to `admin.ts`
- [ ] Integration tests

### Step 6: Integrate UI Routes (1 day)
- [ ] Wrap existing `registerUiRoutes` into RouteModule
- [ ] Clean integration with `config.enableUi` flag

### Step 7: Final Cleanup (1 day)
- [ ] Remove all inline handlers from `app.ts`
- [ ] Simplify `createApp` to just module registration
- [ ] Full integration test suite

## Success Criteria

| Metric | Before | After Each Phase | Final Target |
|--------|--------|------------------|--------------|
| `createApp` lines | 2337 | P1: 800, P2: 500, P3: 150 | <200 |
| File lines (app.ts) | 3048 | P1: 1200, P2: 600, P3: 200 | <300 |
| Handler files | 0 | P1: 0, P2: 5+, P3: 10+ | 10+ |
| Route modules | 0 | P1: 5, P2: 5, P3: 5 | 5 |

## Risk Mitigation

### Route Registration Order
Routes must be registered in a specific order for middleware to apply correctly.

**Mitigation:** Explicit registration order in module array, documented in `types.ts`:
```typescript
export interface RouteModule {
  name: string;
  priority?: number; // Lower = earlier registration
  // ...
}
```

### Dependency Injection
Handlers need access to stores, key pool, etc.

**Mitigation:** Create `HandlerDependencies` interface passed to all handlers:
```typescript
export interface HandlerDependencies {
  keyPool: KeyPool;
  requestLogStore: RequestLogStore;
  // ...
}
```

### Backward Compatibility
Existing tests may import from `app.ts` directly.

**Mitigation:** Export all public functions from `src/routes/index.ts` and deprecate direct `app.ts` imports.

## Rollback Plan
- Each phase is a separate PR
- Feature flags guard new modules:
  - `USE_HEALTH_ROUTES_MODULE`
  - `USE_PROXY_ROUTES_MODULE`
  - etc.
- Can revert individual phases without affecting others