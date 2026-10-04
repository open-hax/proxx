# Local fixture recovery and self-review

Recovery began at Foresight's recorded Proxx revision
`abbbc8b1ad80738233593e17e751203db785c9e2`. The initial results below describe
that pinned checkout. The current-main integration section records a separate
verification after applying the repair to all 134 intervening commits.

## Obstacles and repairs

| Obstacle | What was tried and what worked |
| --- | --- |
| Missing dependencies | The first build lacked TypeScript. A frozen offline install reused 479 packages but could not find `@fastify/swagger@9.5.1`. The frozen online install added 580 packages, reusing 479 and downloading 101 through the shared pnpm store. |
| Unowned provider transports | Automatic approval review rejected an earlier execution that could contact an unverified HTTPS fallback. That process remains untouched. A fresh Node execution used Foresight's audited transport preload, which permits only literal loopback endpoints currently owned by the same test process and makes any refusal fatal. |
| Stale LAN and Chroma defaults | The first fresh full run recorded 14 refused attempts and two failed test files. The route fixture now owns an unavailable LAN endpoint and an explicit unavailable Chroma endpoint. Session search asserts the real fallback result; it no longer accepts either search mode. Session files live in each fixture's temporary directory. |
| Remote quota polling in a streaming test | The stalled-stream fixture now supplies its finite quota response explicitly through the existing fetch fixture. The production quota behavior is unchanged. |
| Reconnecting request pools | Scoped Undici 7.29.0 agents disable pipelining and are destroyed before fixture listeners close. Cleanup restores globals and removes listeners/files even when dispatcher or application shutdown fails. Two injected real teardown failures verify those obligations. The first fault injector recursively called Undici's promise overload; it was stopped, documented, and corrected to preserve the callback overload. |
| Previously skipped cloud reasoning case | Re-enabling the case first selected local Ollama. Neither a preferred provider nor disabling local discovery alone constrained tenant authorization. The fixture now uses the actual authenticated settings route to disable local providers, supplies the cloud catalog, and asserts the upstream request contains `reasoning_effort: "max"`. |
| Generated output lint failures | ESLint first reported 54 errors in generated Shadow externs. Its existing build-output exclusions now include `.shadow-cljs` and `target`; source rules and warning thresholds are unchanged. |
| Nested npm launcher warnings | Build and CLJS test scripts invoke the installed `shadow-cljs` binary directly. This removes three npm configuration warnings and avoids another package launcher. |

## Verification

The fresh production build completed TypeScript and Shadow runtime compilation:
83 compiler inputs, zero warnings. The complete built Node suite ran 651 tests
in 11 suites: **650 passed, zero failed, one existing skip**, with no refused
transports. It completed in 139.2 seconds with actual exit status zero.

The remaining skip is `big-ussy-bootstrap-contract.test.ts`: its external
Services bootstrap script is absent from the initialized repositories. The
fixture was not fabricated, and this checkpoint does not claim that external
deployment contract passed.

Full ESLint exits zero with **zero errors and 236 existing complexity warnings**.
The no-new-TypeScript and declarative-policy boundary checks pass with 262 active
TypeScript paths against the existing 264-path allowance. The teardown and
reasoning focused successor ran three tests, all green with no skips. The patch
version is 0.3.1, unreleased, following the repository's package-version rule.

The executable safety adapter and its nine native regression tests live in
Foresight's `devtools/node-test-loopback.cjs` and
`devtools/node-test-transport.test.cjs`. It is an adapter for this audited Node
surface, not containment for arbitrary native extensions or child programs, and
does not authorize OpenCode/Bun or any earlier rejected process.

## Self-review

Production routing decisions remain in the existing EDN/CLJS policy engine.
The sole production runtime change is the optional `PROXY_SESSIONS_FILE` host
configuration, with the existing explicit argument taking precedence and the
original file path remaining the default. Test cleanup attempts every owned
resource even after a failure and retains the original error. Model requests
still traverse real HTTP fixtures and the compiled policy engine; the restored
reasoning test verifies the actual upstream payload.

The initial gates did not establish a live external provider, PostgreSQL
federation, the absent bootstrap script, or the newer remote main. Current-main
verification follows below; the external integrations remain separate obligations.
No production service was restarted or deployed.


## Current-main integration and independent verification

An isolated worktree was created at remote main
`88471efd7f8cd27f64fc733a1c31369f00a6d432`. The tested pinned repair
`be923300e8d1d76edc5e38e9676e3dbd76351a4b` was cherry-picked without rewriting
history, producing local `092d8307a1abc9d04ed2633c781fde41b77a9dd2`.

The one conflict was in the stalled streaming test. Main now verifies the real
upstream response closes within two seconds. That close promise and assertion
were retained together with the repair's finite quota-response fixture. The
request still traverses the actual app, compiled policy engine, and owned HTTP
upstream. Independent review found no introduced defect in the composed test.

Read-only transport inspection of the integrated `src` found no new child-process
or worker launch and no native-network fallback. Changed HTTP paths still use the
audited Node transport surface. A fresh Node test process used the Foresight
preload, which remained unchanged for the entire run. Earlier rejected processes
were neither inspected nor resumed.

| Fresh gate | Result on the integrated source |
| --- | --- |
| Frozen offline install | Shared pnpm store; exit 0 in 1.8 seconds. No separate dependency cache. |
| `pnpm build` | TypeScript plus Shadow runtime release: 84 inputs, 35 compiled, zero compiler warnings, exit 0. |
| Complete built Node suite | 673 tests in 11 suites; **672 passed, zero failed, one existing skip**, zero refused transports, exit 0 in 107.7 seconds. |
| `pnpm lint` | Exit 0; zero errors and 238 existing warnings, still visible. No rule or threshold was weakened. |
| `pnpm check:no-new-typescript` | Both ownership and declarative-policy checks pass; 264 active TypeScript paths against the existing 266-path allowance. |

The one skip remains the missing external Services bootstrap script described
above; its source fixture was not invented. pnpm reported ignored install scripts
for `@google/genai`, `esbuild`, and `protobufjs`; the actual required production
build and complete built Node suite passed with that installation. No test result
from the old pin was transferred to these 134 intervening commits.

The full suite used the advertised built-test command after the successful build:

```sh
NODE_OPTIONS="--require=/path/to/foresight/devtools/node-test-loopback.cjs" \
  node --test --test-concurrency=1 'dist/tests/**/*.test.js'
```

The preload came from Foresight checkpoint
`1d830897ff44f1fc4d4f036ad682f74e5353dd5d`, independently covered by nine native
transport/exit regressions. Its two source hashes and the built runtime hash are:

| File | SHA-256 |
| --- | --- |
| `node-test-loopback.cjs` | `4576b31455f2ee79f2dc90473d0d62d98f621dfbd84f3f4fad8b3146d8aa49f3` |
| `node-test-transport.cjs` | `c8eb41c8ea7eb51576e08355bcf6bf889e31d39f39c592ddc7736c46e627a40e` |
| `dist/cljs/proxx-runtime.js` | `15f0c7d40476c1bfa82d465e9644ff3c644ee59d8a8bde337dc134e85b9361ce` |

This source integration changes only the original eight repair paths. It does not
claim a deployed external provider, PostgreSQL federation, a frontend browser
gate, or the absent bootstrap contract. The version remains 0.3.1, unreleased.
