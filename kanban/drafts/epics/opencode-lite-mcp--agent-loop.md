---
uuid: "b58cf1e4-5bc4-4044-b4f1-edf9f7d767fe"
title: "Sub-spec: Agent loop + UI integration"
status: incoming
priority: P3
labels: ["specs", "migrated-spec"]
created_at: "2026-05-29T04:01:30.146Z"
source: "kanban/drafts/epics/opencode-lite-mcp--agent-loop.md"
category: "specs"
---

> Source: `kanban/drafts/epics/opencode-lite-mcp--agent-loop.md`
> Migrated-to-kanban: `kanban/drafts/epics/opencode-lite-mcp--agent-loop.md`

# Sub-spec: Agent loop + UI integration

**Epic:** `opencode-lite-mcp-epic.md`
**SP:** 3
**Priority:** P3
**Depends on:** `opencode-lite-mcp--tool-discovery.md`

## Scope
Add a server-side agent/tool-call loop so the web Chat UI can execute MCP tools.

### New endpoint
- `POST /api/agent/chat` — accepts a chat request, calls model, executes tool_calls via MCP/OpenPlanner, feeds outputs back to model, repeats until stop/limit

### Flow
1. Accept chat request
2. Call model (via existing `/v1/chat/completions` pipeline)
3. If `tool_calls` returned:
   - Validate/sanitize each tool call before execution; malformed calls return a structured validation error instead of running
   - Execute via MCP `tools/call` or OpenPlanner tools with per-tool timeout + retry/backoff policy
   - Feed tool outputs back to model
   - Repeat until stop condition or max iterations
4. If max iterations or global timeout is reached, return a partial result with explicit incomplete status and tool call history
5. Return final response with tool call history

### Changes
- `src/routes/agent/index.ts` — new: agent loop endpoint
- Web Chat UI — display tool_calls and tool outputs inline
- Auth: require proxy auth token, tool execution allow-listed

### Security
- MCP tool execution disabled by default unless allow-list configured
- `MCP_TOOL_ALLOW_LIST` env var controls which tools can be invoked
- Unset, empty-string, or whitespace-only `MCP_TOOL_ALLOW_LIST` means no tools are allowed
- When set, `MCP_TOOL_ALLOW_LIST` is a comma-separated, case-insensitive allow-list (for example: `bash,web_search_exa`)

### Error and timeout policy
- Define constants for per-tool timeout, model-step timeout, global request timeout, and max iterations
- MCP/OpenPlanner tool failures return structured error codes so callers can distinguish validation errors, transient tool failures, and timeouts
- Transient MCP failures retry with bounded backoff; permanent failures are surfaced in tool history without infinite looping
- Tool execution failures must not erase prior successful tool outputs from the response transcript

## Verification
- Chat UI can invoke at least one MCP tool end-to-end
- Tool call history is displayed in the UI
- Unauthorized tool calls are rejected
