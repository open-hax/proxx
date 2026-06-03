# Π Last Snapshot — Gemini tool-call round-trip fix

- Timestamp: 2026-06-03T01:53:20Z
- Repo: `/home/err/devel/orgs/open-hax/proxx`
- Branch: `fix/gemini-tool-call-roundtrip`
- Base target: `origin/staging`
- Fix commit: `51feb10`

## Problem

`gemma4:31b` routes (by deployed EDN policy) to provider `gemini` / strategy
`gemini-chat`, aliased to `gemma-4-31b-it`. The gemini completions translation
round-trip lost tool calls/results, so knoxx agent turns finalized with
`:agent-turn/empty-output` ("Agent turn completed without assistant text, tool
calls, or content parts").

## Changed

Three defects fixed in `src/lib/provider-strategy/strategies/gemini.ts`:

1. **Request history** — `openAiMessagesToGeminiContents` only emitted text for
   user/assistant. Assistant `tool_calls` messages (content:null) were dropped
   and `role:"tool"` results had no path. Now maps assistant `tool_calls` →
   `functionCall` parts (role `model`) and tool results → `functionResponse`
   parts (role `user`; Gemini accepts only user/model), resolving the function
   name from `tool_call_id` when omitted and parsing stringified `arguments`.
2. **Part mapping** — `geminiPayloadToSdkRequest` flattened every part to
   `{ text }`, stripping function parts before the SDK call. Now preserves all
   part shapes.
3. **Streaming** — the stream handler only accumulated `chunk.text`, so a
   streamed `functionCall` produced empty content + no tool_calls → empty
   output. Now reads candidate parts and accumulates `functionCall` parts.

Adds `GeminiPart`/`GeminiContent` types and 5 tests. Builds on the prior
(previously uncommitted) `geminiPayloadToSdkRequest` SDK-tools-preservation fix,
which is included in the same commit.

## Boundary

- No secrets added; `DEVEL.md` curls use env-var placeholders only.
- Path-scoped staging; no repo-wide reset/restore/clean.
- New branch cut from `origin/staging`; the merged `fix/policy-boundary-gemma4-deploy`
  branch was left intact. The `.#DEVEL.md` emacs lockfile was left untracked.

## Verification

- `pnpm typecheck` → pass
- `npx tsx --test src/tests/gemini-strategy.test.ts` → 29/29 pass (4 new)
- `pnpm build` (TS + CLJS release) → pass
- Live `proxy.test.ts` → NOT run here (needs a running instance + `PROXY_AUTH_TOKEN`)

## Follow-up

- PR `fix/gemini-tool-call-roundtrip` → `staging`; merge after staging checks.
- Promotion PR `staging` → `main`; verify production deploy + a live
  `gemma4:31b` tool-call probe against `https://proxx.promethean.rest`.
