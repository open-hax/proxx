---
category: "deployment"
labels: "deployment, security, cross-repo, maintenance"
type: "task"
write-id: "1788061696466-0.nt1g2yqv0vcob4wuhq4"
points: "3"
title: "Retire legacy Promethean deployment authority"
priority: "P1"
status: "review"
uuid: "9b050582-778a-499e-b90d-6af4473552d3"
created_at: "2026-08-29T21:59:24.623Z"
---

## Objective

Retire Proxx's active authority over the legacy Promethean deployment lane so Services remains the sole owner of host placement and deployment promotion.

## Audited active callers

- `.github/workflows/deploy-production.yml`
- `.github/workflows/deploy-staging.yml`
- `.github/workflows/deploy-testing.yml`

The staging/testing lane also carries the legacy `error` SSH identity, Promethean host defaults, `/home/error` paths, and `ssh-keyscan`/accept-new trust-on-first-use behavior. The direct shell entry points and two checked-in `deploy/targets/` files preserve the same authority.

## Scope

- Remove the three active reusable-workflow callers.
- Remove direct legacy remote-deploy scripts and checked-in Promethean target files.
- Add a fail-closed repository check preventing those authorities from returning.
- Document the remaining application packaging boundary and Services ownership.
- Preserve historical receipts and compose/Caddy packaging; do not invent a replacement staging target.

## Acceptance criteria

- No active workflow calls `open-hax/services/.github/workflows/deploy-promethean.yml@main`.
- No active Proxx deploy entry point uses the `error` identity, `/home/error`, Promethean host defaults, `ssh-keyscan`, or `StrictHostKeyChecking=accept-new`.
- A self-tested CI guard rejects each retired authority pattern.
- Remaining workflow YAML and shell scripts validate.
- The migration targets `staging`, receives exact-head automated reviews, and leaves merge/protection decisions to the existing staging gate.
- Services issue 22 receives evidence only after the Proxx PR has been reviewed; its state is not changed here.

## Constraints

- Do not add or infer a replacement host, identity, path, secret, or trust bootstrap.
- Do not merge or bypass the staging protection tracked by Proxx issue 308.

---
Audit confirmed exactly three active reusable-workflow callers plus two direct SSH scripts and two checked-in target files on staging SHA 8f5deb39c613855f976c0fa01a827f662dbb5f30. Scope is retirement-only: no replacement deployment target is approved.

Validation passed: deployment-authority self-test (7 fixtures) and live scan; Actionlint 1.7.12; ShellCheck 0.11.0; bash -n; 24 YAML files parsed; no-new-TypeScript and policy-boundary gates; frozen pnpm 9 install; TypeScript + CLJS runtime build (0 warnings); staging offline subset 203/203; CLJS 119 tests / 317 assertions; web production build. The monolithic test command was stopped by workspace policy when its later integration segment attempted an unverified private-network Ollama endpoint; no bypass was attempted.

GitHub issue projection created with the canonical openhax-kanban-sync UUID marker: https://github.com/open-hax/proxx/issues/356. The local card remains the source of truth; the issue is labeled for review and P1/security tracking.

Final promotion audit found one more active authority dependency in .github/workflows/main-pr-gate.yml: the protected staging-promotion-gate still queried for successful deploy-staging and staging-live-e2e checks. Those checks are emitted only by the callers being retired, so leaving the query would make every canonical staging-to-main promotion impossible. The migration now removes only that deployment-evidence query, preserves the staging ancestry assertion and every main application gate, and extends the self-tested authority guard so either retired check name is rejected if reintroduced into an active workflow. GREEN: authority self-test 8/8, live scan, actionlint, diff check, and 18/18 workflow YAML parse plus exact promotion assertions.

PR #433 was published from exact staging base 10a7d2303490127de38afa4d6a17ef8e2670874d. Exact-head Codex review on 4dcde813e67ba8e79a0098f687579b7ef5c715eb found two valid P2 gaps: direct error@host SSH-family invocations escaped the boundary, and README/CONTRIBUTING still advertised deleted deployment workflows. Successor 4f1b77a7cb25050f161ddab647ed385e44c46f19 (tree 28141994591a665933a86b516eded9473c60b88e) repairs both, locks the reported SSH form into the self-test, and records current CI ownership. GREEN: authority self-test 9/9, live scan, actionlint, diff check. Both finding threads have exact evidence replies and are resolved; fresh successor reviews and hosted gates remain required. The separate auto-merge method-policy drift is tracked by issue #434/card PR #435 and is not part of this deployment tree.

Fresh exact-head Codex review on fae8b5b931005af4a77589ce78b5533cc720d457 found a further valid P2 bypass: the direct error@host matcher stopped at a shell line continuation. The boundary now permits only explicit backslash-newline continuations inside the bounded SSH-family command match and locks the reported multiline form into a tenth forbidden fixture. GREEN: self-test 10/10, live scan, actionlint, and diff check. A new immutable successor and fresh exact-head review are required; the rate-limited CodeRabbit request is preserved as evidence and will not be retried repeatedly.

Fresh exact-head Codex review on b126bac7d5af219c4baadc1cefb25e4853d54709 exposed the complete shell-splicing class: a continuation can split the ssh command token or the error@host identity token itself. The guard now normalizes explicit LF/CRLF shell continuations before applying every authority rule while retaining a normalized-to-source offset map for accurate findings. Separate fixtures lock argument-line, identity-token, and command-token splits, plus a source-line assertion. GREEN: 12/12 forbidden patterns, live scan, actionlint, diff check. A fresh immutable successor and exact-head review remain mandatory.

The bounded CodeRabbit review completed on PR #433 head c82ce649e0bde6bb3f10d804e76cfaf477ef9314 and reported four valid Major gaps: mutable candidate policy execution (comment 3888351976), case-sensitive Services owner matching (3888351978), missing ssh -l error and ssh -o User=error forms (3888351982), and incomplete script/composite-action discovery (3888351986). The coherent repair moves enforcement to a pull_request_target workflow from the immutable base revision, treats the candidate checkout strictly as data, adds case-insensitive and option-form coverage, scans every script and composite action, and retains the prior continuation normalization. GREEN before publication: 15 retired-pattern self-tests, live candidate scan, Actionlint, PyYAML parse of all 19 workflows, and git diff check. One immutable successor plus fresh exact-head gates and reviews remain mandatory.

Final local regression on the unpublished combined repair is GREEN with the pinned Java 21 toolchain: pnpm test built TypeScript and the CLJS runtime with zero warnings, then completed 668 tests across 11 suites with 666 pass, 0 fail, and 2 skip in 121.9 seconds. This supplements the 15/15 authority fixtures, live scan, Actionlint, 19/19 workflow parsing, and diff check; exact-head hosted review remains required after publication.

Bootstrap activation audit: GitHub primary documentation confirms pull_request_target definitions execute from the repository default branch, so the new trusted candidate-isolation leg cannot run until the canonical staging-to-main promotion carries deployment-authority.yml onto main. The staging push leg activates immediately when #433 lands. Documentation now states this boundary explicitly: exact-head external review owns the #433 bootstrap, push scanning guards the reviewed staging merge, and default-branch pull-request isolation guards subsequent PRs after promotion. No candidate content is executed.
---