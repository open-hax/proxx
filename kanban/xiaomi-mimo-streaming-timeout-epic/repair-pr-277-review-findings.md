---
uuid: "6f985c43-37a9-4b52-add6-6119cc8f5efd"
title: "Repair PR #277 review findings"
status: "review"
priority: "P1"
labels: [""]
created_at: "2026-08-29T21:47:56.725Z"
parent: "bb6bee41-cf4f-4f46-99e1-53d352c50f00"
write-id: "1788054345040-0.5iupmpk32b9j7pjdyg7"
---

---
Scope from PR #277 review comment 4682243153: (1) remove the Gemini model-family gate from TypeScript; (2) make OpenAI Responses passthrough abort immediately midstream; (3) cap queue timeout extension by the total deadline; (4) add optional :queue/stream-timeout-ms to both request-queue Malli schemas; (5) remove abort listeners after success in Responses, Gemini, Ollama, and Ollama Cloud; (6) normalize provider IDs in classify-rate-limit; (7) normalize provider IDs in provider-route-for-id; (8) validate optional classifyRateLimit in the runtime type guard; (9) behaviorally prove extendTimeout resets the timer; (10) retain one workflow definition or explicitly document compatibility. Acceptance: RED then GREEN coverage, full required backend validation, issue-sync dry run, clean local review, focused repair PR to staging, and no mutation or merge of PR #277 until this repair is green and reviewed. Semantic provider policy remains EDN/CLJS; TypeScript changes are mechanical edge handling only. Evidence base: staging@8f5deb39c613855f976c0fa01a827f662dbb5f30.

Issue-sync dry run completed with live eta-mu Rheos source at d3937a2 after full Proxx all-state issue/label loading and repository-wide duplicate-marker preflight: 142 tasks, 100 non-PR issues, 32 labels, zero duplicate UUID claims, 140 planned operations. The scoped operation is exactly one create-issue for this UUID with labels kanban, status:in_progress, priority:P1 and managed-body SHA-256 829b2e52408fd332ae723bb7127bea46b4c77c07ce07d4150ecb4eff491322d9. The other 139 operations are intentionally not applied in this repair lane; live issue creation will be scoped through the GitHub connector only.

Pre-integration GREEN on staging@8f5deb39: pnpm typecheck; policy boundary; CLJS 122 tests/322 assertions; build:cljs; pnpm build; targeted Node 36/36; required proxy 184 tests/183 pass/1 skip; full pnpm test 666 tests/664 pass/2 skip; actionlint; changed-file ESLint with zero errors; clj-kondo; diff check. During validation, live staging advanced to 51413aa9 via PR #307. This task remains in progress while the exact new base is integrated and the affected/full matrix is rerun before publication.

Exact-base GREEN on staging@d7f7f0ed94d386e4df31639801d0998484f6bd45 after integrating PR #358. Self-review exposed an adjacent hidden cancellation defect: the existing 25 ms OpenAI Responses passthrough stall test took about 120 seconds because awaiting reader.cancel() left the upstream transport open after downstream EOF. The repair now retains the per-response AbortController after headers, aborts the actual fetch transport for both bootstrap and mid-stream body timeouts, and treats reader cancellation as best-effort. Focused regression proves downstream completion near 150 ms and upstream close under 2 seconds. Final validation: typecheck; no-new-TypeScript and policy-boundary gates; changed-file ESLint zero errors; git diff check; focused timeout regression; proxy 184 tests / 183 pass / 1 skip / 0 fail in 62.3 seconds; full pnpm test with Java 21 build 666 tests / 664 pass / 2 skip / 0 fail; prior exact-base actionlint, clj-kondo, CLJS 122 tests / 322 assertions, targeted Node 36/36, and build gates remain green. Ready for independent code review and exact-head hosted gates before merge.

Canonical GitHub projection created as issue #397 after exact UUID/title duplicate searches returned no match. The projection preserves the openhax-kanban-sync marker, review status, P1 priority, source path, full evidence body, and live canonical artifact:issue / kanban / priority:P1 / state:review labels. The focused staging repair PR must close #397 only after exact-head review and protected merge.
---