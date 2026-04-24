# Draft Spec: OpenAI OAuth-backed websearch endpoint

## Goal
Expose a simple **web search** endpoint in `services/open-hax-openai-proxy` that:
- uses the proxy's existing **OpenAI OAuth** accounts (ChatGPT/Codex-style bearer tokens)
- executes an OpenAI **Responses** request that uses the built-in `web_search` tool
- returns a concise markdown result list + optional sources

Primary consumer: pi custom tool (and other local agents) that should not need `OPENAI_API_KEY`.

## Background / Problem
- pi tool `websearch` currently requires `OPENAI_API_KEY`.
- We already have OpenAI OAuth login + account rotation in this proxy.
- We want to reuse those credentials to perform web search.

## Requirements
- New authenticated route: `POST /api/tools/websearch`.
- Request body:
  - `query` (string, required)
  - `numResults` (number, optional, default 8)
  - `searchContextSize` (low|medium|high, optional, default medium)
  - `allowedDomains` (string[], optional)
  - `model` (string, optional; default `openai/gpt-5.3-codex`)
- Route should internally call the existing proxy `POST /v1/responses` with:
  - `tools: [{ type: "web_search", ... }]`
  - `tool_choice: { type: "web_search" }`
  - `include: ["web_search_call.action.sources"]`
  - user prompt instructing markdown list output
  - `stream: false` (proxy may still force upstream streaming; internal handler should return terminal JSON)
- Response JSON:
  - `output` (string)
  - `sources` (array of `{url,title?}`)
  - `responseId` (optional)
  - `model` (string)

## Non-goals
- Building a general-purpose browser tool.
- Adding Exa integration.

## Risks
- The ChatGPT/Codex backend (`/codex/responses`) may not support `web_search` for all accounts/models.
- `include` / `sources` availability may vary; endpoint should degrade gracefully.

## Implementation Plan
### Phase 1
- Add `OPTIONS /api/tools/websearch`.
- Add `POST /api/tools/websearch` handler in `src/app.ts`.
- Implement minimal response parsing helpers in a small module or inline.

### Phase 2
- Add test covering:
  - endpoint calls upstream `/v1/responses`
  - payload includes `tools[0].type === "web_search"` and `tool_choice.type === "web_search"`
  - returns `output` and `sources` extracted from terminal response.

## Definition of Done
- `pnpm test` passes.
- Manual call returns markdown list when OpenAI OAuth account supports web search.
