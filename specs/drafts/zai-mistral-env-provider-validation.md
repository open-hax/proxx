# Spec Draft: z.ai + Mistral Env Provider Support and Live Key Validation

## Summary
Add native env-backed provider support for z.ai and Mistral, ensure z.ai uses the correct OpenAI-compatible endpoint paths, and validate all newly added provider keys from `services/proxx/.env` against real upstream endpoints without exposing secrets.

## Open Questions
- Should `REQUEST_API_TOKEN` be treated as an alias for `REQUESTY_API_TOKEN` if it appears in user env files? Current evidence suggests `REQUESTY_API_TOKEN` is already present at runtime, so aliasing is not required for this slice.
- Should ElevenLabs be supported in this proxy now? Current scope says no: it is outside the current text/chat provider surface.

## Risks
- z.ai uses `/api/paas/v4/chat/completions` and `/api/paas/v4/models`, not the generic `/v1/*` OpenAI-compatible path shape used by other providers.
- Adding provider support must not perturb existing routing for requesty/openrouter/gemini/factory/openai.
- Live validation must avoid leaking any secret material into logs or assistant output.

## Priority
High — user explicitly wants z.ai support and wants the newly added API keys validated.

## Implementation Phases
1. **Investigation**
   - Inspect provider env-loading and base-URL defaults.
   - Validate which keys are present in `services/proxx/.env` without printing values.
   - Probe real upstream endpoints for z.ai, Mistral, OpenRouter, Requesty, and Gemini.
2. **Implementation**
   - Add env-backed `zai` and `mistral` providers.
   - Add z.ai-specific chat-completions strategy/path handling.
   - Update docs/examples if needed.
3. **Verification**
   - Add tests for config/env loading and z.ai path selection.
   - Run full package tests.
   - Summarize live key validation outcomes.

## Affected Files
- `src/lib/config.ts`
- `src/lib/key-pool.ts`
- `src/lib/provider-strategy/registry.ts`
- `src/lib/provider-strategy/strategies/*.ts`
- `src/tests/key-pool.test.ts`
- `src/tests/proxy.test.ts`
- `README.md`
- `.env.example`
- `specs/drafts/zai-mistral-env-provider-validation.md`
- `receipts.log`

## Definition of Done
- z.ai can be selected as a provider and reaches the correct upstream endpoints.
- Mistral can be loaded from env as a provider.
- Tests pass.
- Live key validation summary exists for all relevant newly added keys.

## Progress
- [x] Investigation started.
- [ ] Implementation
- [ ] Verification
