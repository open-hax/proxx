# Spec: responses-compat.ts Refactor

## Problem Statement
`processEvent` in `src/lib/responses-compat.ts` has:
- **Cyclomatic complexity: 67** (target: <20)
- **Cognitive complexity: 113** (target: <30)
- **File lines: 1514** (target: <500)

The function handles SSE stream parsing for OpenAI Responses API.

## Root Causes

### 1. Giant Switch Statement
```typescript
function processEvent(type: string, payload: unknown): void {
  switch (type) {
    case 'response.created':
      // 30 lines
    case 'response.output_item.added':
      // 40 lines
    case 'response.function_call_arguments.delta':
      // 50 lines
    case 'response.content_part.added':
      // 20 lines
    case 'response.reasoning_content.delta':
      // 25 lines
    // ... 20+ more cases
    default:
      // 10 lines
  }
}
```

### 2. Deeply Nested State Updates
Each case modifies shared state with nested conditionals:
```typescript
case 'response.output_item.added': {
  const item = payload.item;
  if (item.type === 'function_call') {
    const callId = item.call_id;
    if (callId) {
      if (itemId) {
        functionCallState.set(slotIdx, { ... }); // nested mutation
      }
    }
  }
  // ...
}
```

### 3. Multiple Response Format Handlers
The file handles conversion between:
- Responses API → Chat Completions
- Responses API → SSE chunks
- Error extraction from streams
- Image generation responses

## Proposed Refactoring

### Phase 1: Event Handler Registry (target: complexity <40)

#### 1.1 Create Event Handler Interface
```typescript
// src/lib/responses-compat/handlers/types.ts
export interface StreamingEventHandler {
  readonly eventType: string;
  handle(context: StreamContext, payload: unknown): void;
}

export interface StreamContext {
  emit: (chunk: ChatCompletionChunk) => void;
  state: StreamState;
  model: string;
}
```

#### 1.2 Create Handler Registry
```typescript
// src/lib/responses-compat/handlers/registry.ts
export class EventHandlerRegistry {
  private handlers = new Map<string, StreamingEventHandler>();

  register(handler: StreamingEventHandler): void {
    this.handlers.set(handler.eventType, handler);
  }

  handle(eventType: string, context: StreamContext, payload: unknown): void {
    const handler = this.handlers.get(eventType);
    if (handler) {
      handler.handle(context, payload);
    }
  }
}
```

#### 1.3 Extract Individual Handlers
```typescript
// src/lib/responses-compat/handlers/response-created.ts
export const responseCreatedHandler: StreamingEventHandler = {
  eventType: 'response.created',
  handle(context, payload) {
    // ~15 lines of clean handling
  }
};

// src/lib/responses-compat/handlers/output-item-added.ts
export const outputItemAddedHandler: StreamingEventHandler = {
  eventType: 'response.output_item.added',
  handle(context, payload) {
    const item = parseItem(payload);
    if (item.type === 'function_call') {
      handleFunctionCallItem(context, item);
    } else if (item.type === 'message') {
      handleMessageItem(context, item);
    }
    // ~20 lines
  }
};

// src/lib/responses-compat/handlers/delta.ts
export const functionCallDeltaHandler: StreamingEventHandler = {
  eventType: 'response.function_call_arguments.delta',
  handle(context, payload) {
    // ~15 lines
  }
};
```

### Phase 2: State Machine Pattern (target: complexity <25)

Replace imperative state mutations with state machine:

```typescript
// src/lib/responses-compat/state-machine.ts
export type StreamState = 'idle' | 'streaming' | 'function_calling' | 'reasoning' | 'error' | 'complete';

export const transitions: Record<StreamState, Set<StreamState>> = {
  'idle': new Set(['streaming', 'function_calling', 'reasoning']),
  'streaming': new Set(['streaming', 'function_calling', 'reasoning', 'error', 'complete']),
  'function_calling': new Set(['streaming', 'complete', 'error']),
  'reasoning': new Set(['streaming', 'complete', 'error']),
  'error': new Set(['complete']),
  'complete': new Set(),
};

export function transition(current: StreamState, event: string): StreamState | null {
  // State transition logic
}
```

### Phase 3: Format Conversion Separation (target: clean separation)

Extract conversion logic into dedicated modules:

```typescript
// src/lib/responses-compat/converters/to-chat-completion.ts
export function responsesToChatCompletion(
  response: ResponsesApiResponse,
  model: string
): ChatCompletion {
  // ~50 lines
}

// src/lib/responses-compat/converters/to-sse-chunks.ts  
export function* streamResponsesToChatCompletionChunks(
  stream: AsyncIterable<ResponsesStreamEvent>,
  options: ConversionOptions
): Generator<ChatCompletionChunk> {
  // ~80 lines with yielded chunks
}

// src/lib/responses-compat/converters/extract-images.ts
export function extractImagesFromResponsesPayload(
  payload: ResponsesApiOutput
): ImageGenerationResult | undefined {
  // ~30 lines
}
```

## File Structure After Refactoring

```
src/lib/responses-compat/
├── index.ts                          # Public exports (~50 lines)
├── state-machine.ts                   # StreamState, transitions (~60 lines)
├── handlers/
│   ├── types.ts                       # StreamingEventHandler interfaces
│   ├── registry.ts                    # EventHandlerRegistry (~40 lines)
│   ├── response-created.ts           # Handler (~20 lines)
│   ├── output-item-added.ts          # Handler (~25 lines)
│   ├── delta.ts                       # Delta handlers (~40 lines)
│   ├── reasoning-delta.ts            # Reasoning handler (~30 lines)
│   ├── content-part.ts               # Content handlers (~30 lines)
│   └── error.ts                       # Error handlers (~20 lines)
├── converters/
│   ├── to-chat-completion.ts         # Responses → Chat (~50 lines)
│   ├── to-sse-chunks.ts               # Stream → SSE chunks (~80 lines)
│   ├── extract-images.ts             # Image extraction (~30 lines)
│   └── extract-error.ts              # Error extraction (~25 lines)
└── stream-processor.ts                # Main processor (~100 lines)
```

## Migration Plan

### Step 1: Create Infrastructure (1 day)
- [ ] Create `src/lib/responses-compat/handlers/types.ts`
- [ ] Create `src/lib/responses-compat/handlers/registry.ts`
- [ ] Create `StreamContext` and `StreamState` interfaces
- [ ] Add unit tests for registry

### Step 2: Extract High-Volume Handlers (2 days)
- [ ] Extract `response.created` handler
- [ ] Extract `response.output_item.added` handler
- [ ] Extract `response.function_call_arguments.delta` handler
- [ ] Extract `response.content_part.added` handler
- [ ] Register handlers, wire into existing `processEvent`
- [ ] Unit tests for each handler

### Step 3: Extract Remaining Handlers (2 days)
- [ ] Extract all other event type handlers (~15 more)
- [ ] Replace giant switch with registry dispatch
- [ ] Update tests

### Step 4: Extract Converters (1 day)
- [ ] Create `converters/to-chat-completion.ts`
- [ ] Create `converters/to-sse-chunks.ts`
- [ ] Create `converters/extract-images.ts`
- [ ] Create `converters/extract-error.ts`
- [ ] Update public exports

### Step 5: Create Stream Processor (1 day)
- [ ] Create `stream-processor.ts` with state machine
- [ ] Integrate handlers and converters
- [ ] Replace existing `streamResponsesSseToChatCompletionChunks`
- [ ] Integration tests

## Success Criteria

| Metric | Before | After Each Phase | Final Target |
|--------|--------|------------------|--------------|
| `processEvent` complexity | 67 | P1: 40, P2: 25, P3: 15 | <15 |
| `processEvent` cognitive | 113 | P1: 60, P2: 30, P3: 15 | <15 |
| File lines | 1514 | P1: 1000, P2: 600, P3: 300 | <300 |
| Handler files | 0 | P1: 5, P2: 10, P3: 15 | 15+ |
| Converter files | 0 | P1: 0, P2: 0, P3: 4 | 4 |

## Risk Mitigation

### SSE Stream Order Dependency
Events must be processed in order; handler order matters for state updates.

**Mitigation:** Registry preserves registration order; state machine validates transitions.

### Response Format Edge Cases
Some events have rare edge cases (empty payloads, missing fields).

**Mitigation:** Each handler validates payload shape and handles gracefully:
```typescript
handle(context, payload) {
  if (!isResponseCreatedEvent(payload)) {
    context.state = 'error';
    return;
  }
  // ...
}
```

### Backward Compatibility
External callers use `responsesToChatCompletion`, `streamResponsesSseToChatCompletionChunks`.

**Mitigation:** Public API unchanged; internal refactoring only:
```typescript
// index.ts
export { responsesToChatCompletion } from './converters/to-chat-completion.js';
export { streamResponsesSseToChatCompletionChunks } from './stream-processor.js';
```

## Rollback Plan
- Handlers can be removed individually
- Registry can be unwound back to switch statement
- Converters can be re-inlined into main file
- Each phase is independent PR