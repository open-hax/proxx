# Π Snapshot — 2026-03-17T05:12:18Z

- Repo: `open-hax-openai-proxy`
- Branch: `main`
- Remote: `origin/main`
- Base HEAD at capture start: `4ba3-8813-697e`
- Previous Π commit: `021b-82a1-7dc9`
- Working tree at capture start: dirty

## What changed
- Route /v1/responses GPT requests through Factory responses endpoint selection when Factory is chosen.
- Add image-cost/accounting plumbing across src/lib/provider-strategy.ts, src/lib/request-log-store.ts, src/lib/ui-routes.ts, web/src/lib/api.ts, and web/src/pages/DashboardPage.tsx.
- Surface image cost configuration in .env.example and docker-compose.yml, and update ProxyConfig test fixtures to keep pnpm test green.
- Expose factory/gpt-5.4 in models.example.json.
- Record spec draft, receipts, and Π handoff artifacts; local push remains blocked by missing GitHub credentials.

## Files to inspect
- `.env.example`
- `docker-compose.yml`
- `src/lib/config.ts`
- `src/lib/provider-strategy.ts`
- `src/lib/request-log-store.ts`
- `src/lib/ui-routes.ts`
- `web/src/lib/api.ts`
- `web/src/pages/DashboardPage.tsx`
- `src/tests/factory-strategy.test.ts`
- `src/tests/policy.test.ts`
- `src/tests/proxy.test.ts`
- `models.example.json`
- `specs/drafts/endpoint-agnostic-routing.md`
- `receipts.log`

## Verification
- pass: `pnpm run build`
- pass: `node --test dist/tests/factory-strategy.test.js`
- pass: `curl /v1/responses model=gpt-5.4 stream=false`
- pass: `pnpm test (251/251)`

## Open questions
- Does Factory.ai accept stream=false on /api/llm/o/v1/responses?
- Should requesty/openrouter get a general responses→chat fallback?

## Push status
- local Π tag created for the snapshot commit
- push blocked: `fatal: could not read Username for 'https://github.com': No such device or address`

## Notes
- `.ημ/*` captures the pre-Π base head; final commit and tag refs are reported by git after snapshot creation.
- Existing branch state already included `feat: OpenAI images fallback via Codex Responses image_generation` ahead of `origin/main`.
