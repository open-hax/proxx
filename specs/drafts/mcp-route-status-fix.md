# Spec: Fix MCP route status descriptor

**Status:** Draft
**Story points:** 1
**Audit ref:** `specs/audits/2026-04-02-ad-hoc-routing-code-audit.md` Finding 8

## Problem

`src/routes/api/v1/index.ts:62-67` lists the MCP endpoint as `"implemented"`:

```typescript
mcp: {
  path: "/api/v1/mcp",
  legacyPath: "/api/ui/mcp-servers",
  status: "implemented",
  description: "MCP discovery endpoints migrating from the legacy UI surface.",
},
```

But `src/routes/mcp/index.ts` is a no-op:
```typescript
export async function registerMcpRoutes(_app: FastifyInstance, _deps: UiRouteDependencies): Promise<void> {}
```

The `/api/v1` discovery endpoint returns this as implemented, misleading clients.

## Scope

1. Change the MCP status from `"implemented"` to `"planned"` in `src/routes/api/v1/index.ts`
2. Verify `/api/v1` returns the corrected status

## Non-goals

- Implementing the actual MCP routes (that's a separate feature)

## Verification

- `pnpm build` passes
- `curl -s localhost:8789/api/v1 | jq '.endpoints.mcp.status'` returns `"planned"`
