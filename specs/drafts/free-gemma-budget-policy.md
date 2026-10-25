# Free Gemma with bounded paid fallback

The local Knoxx social agent must prefer the free Requesty Google Gemma route while retaining a paid DeepInfra escape route. The October audit attributes $9.33 of $9.46 to the creative cron session. Paid route pricing was incorrectly inherited from the free canonical model. This work must make the routing, actual costs, and remaining allowance visible through the existing Orbit constellation dashboard.

## Accepted limits

The user selected **$0.50 per day and $5 per month**, both enforced for this bot's paid DeepInfra fallback. Free and local requests do not consume the allowance. Use UTC calendar boundaries and show those boundaries in Orbit. This is an internal routing allowance, not authorization for another provider top-up.

The limit must include concurrent in-flight requests. Reserve a conservative upper bound before a paid request, settle with actual billed token usage after completion, and retain an unreconciled reservation if usage is missing or a process dies. Durable SQL transactions must prevent restart/concurrency overspend. Fail closed when the paid route cannot establish its cost bound. Do not refund an uncertain upstream charge merely because the downstream disconnected.

## Implementation stories and acceptance evidence

1. Route-specific pricing: explicit EDN contract prices for free Google and paid DeepInfra; forced prices work without catalog coverage. Preserve requested model and actual upstream model separately, and compute cost from the latter. Prove the two routes cannot collapse to canonical free pricing.
2. Economy routing: declare workload identification and ordered upstream models in EDN, interpret in CLJS, use TypeScript only for transport/storage. Free route first; affinity/performance sorting cannot silently promote paid routes. Paid attempt admission requires the durable reservation. No unlimited paid retry path.
3. Latency: measure first visible content separately from reasoning and headers. A free attempt must yield usable output inside the accepted 20-second ceiling; fallback must occur before committing downstream stream headers/content. Keep adequate time for fallback rather than spending the entire user-facing budget on the first route. Capture p50/p95, sample counts, throughput and failures under comparable prompts/concurrency; three overnight samples do not establish a tail SLA.
4. Knoxx evaluation: inspect loaded local contracts and generated overrides. Compare E4B and 31B on the same safe tasks/context; evaluate direct calls and Lens context separately. Score grounded answers, tool choice, instruction following, hallucination, first visible latency, throughput and terminal error handling. Do not post publicly as an evaluation side effect.
5. Orbit: extend the existing authenticated constellation surface with active agent/loaded contract, selected upstream route, free/paid usage, actual/estimated/unpriced distinction, daily/monthly spent/reserved/remaining, reset times, latency distributions, and evaluation evidence. Never expose provider credentials or private prompt text.
6. Release: settle current-head PR review, deploy through Services, verify image/source and compiled route/pricing/budget canaries, then observe a real bot request using the free route. Check paid fallback below and at both caps without charging real over-budget requests.

## Scope boundaries

Do not replace the existing Orbit integration. Do not copy workstation Google credentials to production, enable consumer OAuth proxying, activate auto-refill, or treat HTTP health as proof of free inference. Preserve other agents' dirty Knoxx work and all live sessions.

## Progress

The forced-price regression was reproduced and repaired. EDN route prices and compiled-manifest integration coverage are prepared. Budget persistence/admission, routing, upstream attribution, Knoxx evaluation, Orbit integration, review and deployment remain pending. Nothing from this branch is deployed yet.
